'use strict';

const http = require('http');
const C = require('./constants');
const { createPkcePair, createState } = require('./pkce');
const { classifyTokenFailure, networkError } = require('./oauth');

// ============================================================
// OpenAI（Codex / ChatGPT 訂閱）OAuth：
// 開瀏覽器登入 → 本機 1455 埠自動接收授權碼 → 換 token。
// 全程不需要使用者複製貼上。
// ============================================================

const REDIRECT_URI = `http://localhost:${C.OPENAI_CALLBACK_PORT}${C.OPENAI_CALLBACK_PATH}`;

function buildAuthorization() {
  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: C.OPENAI_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: C.OPENAI_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    // 下面兩個是 Codex CLI 登入時會帶的參數，跟著帶以確保流程一致
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
  });
  return { url: `${C.OPENAI_AUTHORIZE_URL}?${params.toString()}`, verifier, state };
}

// 啟動一次性的本機回跳伺服器；回傳 { promise, close }
// promise 會在瀏覽器回跳時 resolve({ code })，或被 close()/逾時 reject。
// opts 可換埠號／路徑。
function startCallbackServer(expectedState, timeoutMs = 5 * 60 * 1000, opts = {}) {
  const port = opts.port || C.OPENAI_CALLBACK_PORT;
  const callbackPath = opts.path || C.OPENAI_CALLBACK_PATH;
  const who = opts.who || 'Codex';
  let server = null;
  let settled = false;
  let closeFn = () => {};

  const promise = new Promise((resolve, reject) => {
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 稍等一下讓瀏覽器收到回應頁再關伺服器
      setTimeout(() => {
        try { server.close(); } catch { /* 已關就算了 */ }
      }, 1500);
      fn(value);
    };

    const timer = setTimeout(
      () => finish(reject, new Error('等太久沒有收到瀏覽器回跳，請重新開始授權')),
      timeoutMs
    );

    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname !== callbackPath) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const err = url.searchParams.get('error');

      const page = (title, body) =>
        `<!DOCTYPE html><html lang="zh-Hant"><meta charset="utf-8"><title>${title}</title>` +
        `<body style="font-family:'Segoe UI','Microsoft JhengHei',sans-serif;background:#14161f;color:#e8ecf5;` +
        `display:flex;align-items:center;justify-content:center;height:100vh;margin:0">` +
        `<div style="text-align:center"><h2>${title}</h2><p style="color:#9aa3b8">${body}</p></div></body></html>`;

      if (err) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('授權沒有完成', `錯誤：${err}。回到小工具重試即可。`));
        finish(reject, new Error(`授權被拒絕或失敗（${err}）`));
        return;
      }
      if (!code || (expectedState && state !== expectedState)) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page('這個授權連結不對', '請回到小工具重新開始授權流程。'));
        return; // 不 settle，繼續等正確的回跳
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page('授權成功 ✓', '可以關掉這個分頁，回到「AI 用量監控」小工具了。'));
      finish(resolve, { code });
    });

    server.on('error', (e) => {
      if (e && e.code === 'EADDRINUSE') {
        finish(reject, new Error(`本機 ${port} 埠被占用（可能有其他程式正在登入 ${who}），關掉後再試`));
      } else {
        finish(reject, e);
      }
    });

    server.listen(port, '127.0.0.1');

    closeFn = () => finish(reject, new Error('授權流程已取消'));
  });

  return { promise, close: () => closeFn() };
}

async function postToken(bodyFields) {
  let res;
  let text;
  try {
    res = await fetch(C.OPENAI_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(bodyFields).toString(),
      signal: AbortSignal.timeout(C.FETCH_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    // 連不上／逾時 → 暫時性，保留舊憑證稍後再試（不要重送同一個 refresh token）
    throw networkError('無法連線到 OpenAI token 端點', err);
  }
  let data = null;
  try { data = JSON.parse(text); } catch { /* 留原文除錯 */ }
  if (!res.ok || !data || !data.access_token) {
    const desc = (data && (data.error_description || (data.error && data.error.message) || data.error)) || text.slice(0, 200);
    const err = new Error(`OpenAI token 端點回應 ${res.status}：${typeof desc === 'string' ? desc : JSON.stringify(desc)}`);
    const kind = classifyTokenFailure(res.status, data);
    err.status = res.status;
    err.definitive = kind === 'auth';
    err.transient = kind === 'transient';
    throw err;
  }
  return data;
}

// 從 JWT（不驗簽，只讀內容）解出帳號資訊
function decodeJwtClaims(token) {
  try {
    const payload = token.split('.')[1];
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function extractIdentity(tokenData) {
  const fromId = decodeJwtClaims(tokenData.id_token || '');
  const fromAccess = decodeJwtClaims(tokenData.access_token || '');
  const authClaim = fromAccess['https://api.openai.com/auth'] || fromId['https://api.openai.com/auth'] || {};
  return {
    accountId: authClaim.chatgpt_account_id || null,
    email: fromId.email || fromAccess.email || null,
    planType: authClaim.chatgpt_plan_type || null,
  };
}

function normalizeTokenResponse(data, fallbackRefreshToken) {
  const expiresInSec = Number(data.expires_in) || 3600;
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefreshToken || null,
    idToken: data.id_token || null,
    expiresAt: Date.now() + expiresInSec * 1000,
    refreshedAt: Date.now(), // 上次成功拿到 token 的時間（保鮮判斷用）
  };
}

async function exchangeCode({ code, verifier }) {
  const data = await postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: C.OPENAI_CLIENT_ID,
    code_verifier: verifier,
  });
  return { tokens: normalizeTokenResponse(data), identity: extractIdentity(data) };
}

async function refreshTokens(refreshToken) {
  const data = await postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: C.OPENAI_CLIENT_ID,
  });
  return normalizeTokenResponse(data, refreshToken);
}

module.exports = {
  buildAuthorization,
  startCallbackServer,
  exchangeCode,
  refreshTokens,
  extractIdentity,
  decodeJwtClaims,
  REDIRECT_URI,
};

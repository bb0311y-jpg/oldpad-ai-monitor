'use strict';

const C = require('./constants');
const { createPkcePair, createState } = require('./pkce');

// ============================================================
// Claude OAuth：建授權連結、用授權碼換 token、用 refresh token 續期
// ============================================================

function buildAuthorization() {
  const { verifier, challenge } = createPkcePair();
  const state = createState();
  const params = new URLSearchParams({
    code: 'true', // 讓回跳頁直接把授權碼顯示出來給使用者複製
    client_id: C.CLAUDE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: C.CLAUDE_REDIRECT_URI,
    scope: C.CLAUDE_SCOPES,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
  });
  return { url: `${C.CLAUDE_AUTHORIZE_URL}?${params.toString()}`, verifier, state };
}

async function fetchWithTimeout(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(C.FETCH_TIMEOUT_MS) });
}

// 分類 token 端點的失敗：
//   auth      → 授權真的失效（invalid_grant、401/403），要重新登入
//   format    → 其他 4xx，可能是請求格式不合，換格式／端點再試
//   transient → 5xx／429，伺服器暫時有問題
function classifyTokenFailure(status, data) {
  const code = data && typeof data.error === 'string' ? data.error : (data && data.error && data.error.code) || '';
  if (status === 401 || status === 403) return 'auth';
  if (status === 400 && C.OAUTH_DEFINITIVE_ERRORS.includes(code)) return 'auth';
  if (status === 429 || status === 408) return 'transient'; // 限流／逾時：等一下再試
  if (status >= 400 && status < 500) return 'format';
  return 'transient';
}

// 網路層失敗（連不上、逾時）：包成「暫時性」錯誤。
// 注意：refresh token 只能用一次，連線失敗時不要立刻換格式再送同一個 token，
// 萬一第一次其實已送達，重送會被判定「重複使用」而把整條授權鏈撤銷。
function networkError(prefix, err) {
  const why = err && err.name === 'TimeoutError' ? '逾時' : (err && err.message) || String(err);
  const e = new Error(`${prefix}（${why}）`);
  e.transient = true;
  return e;
}

// 對 token 端點送請求。不同時期的服務端接受的格式略有差異，
// 因此依序嘗試：主端點+表單 → 主端點+JSON → 備援端點……直到成功。
async function postTokenRequest(bodyFields) {
  const attempts = [];
  for (const url of C.CLAUDE_TOKEN_URLS) {
    attempts.push({ url, mode: 'form' }, { url, mode: 'json' });
  }

  let lastError = null;
  for (const { url, mode } of attempts) {
    let res;
    let text;
    try {
      res = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
          'Content-Type': mode === 'form' ? 'application/x-www-form-urlencoded' : 'application/json',
          'User-Agent': C.CLAUDE_USER_AGENT,
          'anthropic-beta': C.CLAUDE_BETA_HEADER,
        },
        body: mode === 'form' ? new URLSearchParams(bodyFields).toString() : JSON.stringify(bodyFields),
      });
      text = await res.text();
    } catch (err) {
      throw networkError('無法連線到 token 端點', err);
    }
    let data = null;
    try { data = JSON.parse(text); } catch { /* 保留原文以利除錯 */ }

    if (res.ok && data && data.access_token) return data;

    const kind = classifyTokenFailure(res.status, data);
    lastError = new Error(
      `token 端點回應 ${res.status}：${(data && (data.error_description || data.error)) || text.slice(0, 200)}`
    );
    lastError.status = res.status;
    lastError.definitive = kind === 'auth';
    lastError.transient = kind === 'transient';
    if (kind === 'auth') throw lastError; // 授權確定失效，換格式再試沒有意義
    // format / transient → 試下一個格式或備援端點
  }
  throw lastError || new Error('無法連線到 token 端點');
}

// 使用者貼回來的授權碼格式是「<code>#<state>」，# 後面是 state 回聲
function parsePastedCode(pasted) {
  const trimmed = String(pasted || '').trim();
  if (!trimmed) throw new Error('授權碼是空的');
  const [code, echoedState] = trimmed.split('#');
  if (!code) throw new Error('授權碼格式不正確');
  return { code: code.trim(), echoedState: (echoedState || '').trim() };
}

async function exchangeCode({ pastedCode, verifier, state }) {
  const { code, echoedState } = parsePastedCode(pastedCode);
  if (echoedState && state && echoedState !== state) {
    throw new Error('授權碼與本次授權請求不相符（state 不一致），請重新走一次授權流程');
  }
  const data = await postTokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: C.CLAUDE_REDIRECT_URI,
    client_id: C.CLAUDE_CLIENT_ID,
    code_verifier: verifier,
    state: echoedState || state,
  });
  return normalizeTokenResponse(data);
}

async function refreshTokens(refreshToken) {
  const data = await postTokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: C.CLAUDE_CLIENT_ID,
  });
  return normalizeTokenResponse(data, refreshToken);
}

function normalizeTokenResponse(data, fallbackRefreshToken) {
  const expiresInSec = Number(data.expires_in) || 8 * 3600;
  return {
    accessToken: data.access_token,
    // 服務端可能輪替 refresh token；沒給新的就沿用舊的
    refreshToken: data.refresh_token || fallbackRefreshToken || null,
    expiresAt: Date.now() + expiresInSec * 1000,
    refreshedAt: Date.now(), // 上次成功拿到 token 的時間（保鮮判斷用）
    scopes: data.scope || null,
  };
}

module.exports = { buildAuthorization, exchangeCode, refreshTokens, parsePastedCode, classifyTokenFailure, networkError };

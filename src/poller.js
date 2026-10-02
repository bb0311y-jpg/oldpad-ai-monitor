'use strict';

const C = require('./constants');
const oauth = require('./oauth');
const oauthOpenai = require('./oauth-openai');
const claudeProvider = require('./providers/claude');
const codexProvider = require('./providers/codex');
const demoProvider = require('./providers/demo');

// 各服務的「抓用量」與「token 續期」實作
const PROVIDERS = {
  claude: {
    fetchUsage: (account, token) => claudeProvider.fetchUsage(token),
    refresh: (refreshToken) => oauth.refreshTokens(refreshToken),
  },
  codex: {
    fetchUsage: (account, token) => codexProvider.fetchUsage(token, account.accountId),
    refresh: (refreshToken) => oauthOpenai.refreshTokens(refreshToken),
  },
};

// ============================================================
// 輪詢器：定時幫每個帳號抓用量。
//  - token 快過期會先自動續期（refresh token）
//  - 距上次續期太久也會主動續一次（保鮮，讓授權鏈不會因閒置失效）
//  - 失敗會退避重試（429 或網路錯誤時拉長間隔）
//  - 只有「授權確定失效」（invalid_grant／401／403）才標記需要重新授權；
//    網路不通、伺服器 5xx 這類暫時性失敗保留舊憑證、稍後自動重試
// ============================================================

class UsagePoller {
  /**
   * @param {object} deps
   * @param {() => Array} deps.getAccounts        取得目前帳號清單
   * @param {(account) => void} deps.onAccountUpdated  token 續期後回寫
   * @param {(accountId, result) => void} deps.onResult 抓完一個帳號的結果
   * @param {(accountId, raw) => void} [deps.onRaw]     原始回應（除錯）
   * @param {(accountId, kind, detail) => void} [deps.onEvent] 續期成功／失敗等事件（寫紀錄用）
   * @param {object} [deps.providers]                    測試用：換掉各服務的實作
   */
  constructor({ getAccounts, onAccountUpdated, onResult, onRaw, onEvent, providers }) {
    this.getAccounts = getAccounts;
    this.onAccountUpdated = onAccountUpdated;
    this.onResult = onResult;
    this.onRaw = onRaw || (() => {});
    this.onEvent = onEvent || (() => {});
    this.providers = providers || PROVIDERS;
    this.intervalMinutes = C.DEFAULT_REFRESH_MINUTES;
    this.timer = null;
    this.state = new Map(); // accountId -> { nextAt, failures, inFlight, keepaliveNextAt }
    this.refreshLocks = new Map(); // accountId -> Promise（避免同帳號並發續期）
  }

  start() {
    if (this.timer) return;
    // 每 20 秒檢查一次「誰到了該更新的時間」，實際頻率由 nextAt 控制
    this.timer = setInterval(() => this.tick(), 20 * 1000);
    this.refreshAll(true);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  setIntervalMinutes(minutes) {
    this.intervalMinutes = Math.max(1, Number(minutes) || C.DEFAULT_REFRESH_MINUTES);
    this.refreshAll(false); // 依新間隔重排（不強制立即抓）
  }

  _stateOf(id) {
    if (!this.state.has(id)) this.state.set(id, { nextAt: 0, failures: 0, inFlight: false, keepaliveNextAt: 0 });
    return this.state.get(id);
  }

  tick() {
    const now = Date.now();
    for (const account of this.getAccounts()) {
      const st = this._stateOf(account.id);
      if (!st.inFlight && now >= st.nextAt) this.fetchOne(account.id);
    }
  }

  refreshAll(force) {
    const now = Date.now();
    this.getAccounts().forEach((account, i) => {
      const st = this._stateOf(account.id);
      if (force) {
        // 直接排定抓取，帳號之間錯開 800ms，避免同時打 API
        st.nextAt = now + i * 800;
        setTimeout(() => this.fetchOne(account.id), i * 800);
      } else {
        st.nextAt = Math.min(st.nextAt, now + this.intervalMinutes * 60 * 1000);
      }
    });
  }

  async fetchOne(accountId, force = false) {
    const account = this.getAccounts().find((a) => a.id === accountId);
    if (!account) return;
    const st = this._stateOf(accountId);
    if (st.inFlight) return;
    if (account.needsReauth && !force) {
      st.nextAt = Date.now() + 10 * 60 * 1000; // 等使用者重新授權，不用一直打
      return;
    }
    st.inFlight = true;
    try {
      let result;
      if (account.provider === 'demo') {
        result = await demoProvider.fetchUsage(null, account.demoSeed || 1);
      } else {
        const impl = this.providers[account.provider] || this.providers.claude;
        const accessToken = await this._ensureFreshToken(account, impl);
        result = await impl.fetchUsage(account, accessToken);
      }
      this.onRaw(accountId, result.raw);
      st.failures = 0;
      st.nextAt = Date.now() + this.intervalMinutes * 60 * 1000;
      this.onResult(accountId, {
        ok: true,
        buckets: result.buckets,
        fetchedAt: Date.now(),
      });
    } catch (err) {
      const isAuth = err && err.code === 'AUTH';
      if (isAuth) {
        if (!account.needsReauth) this.onEvent(accountId, 'reauth_needed', err.message);
        account.needsReauth = true;
        this.onAccountUpdated(account);
      } else {
        this.onEvent(accountId, 'fetch_fail', err && err.message ? err.message : String(err));
      }
      st.failures += 1;
      // 退避：最少 1 分鐘，最多 30 分鐘
      const backoffMs = Math.min(30 * 60 * 1000, 60 * 1000 * 2 ** Math.min(st.failures, 5));
      st.nextAt = Date.now() + (isAuth ? 10 * 60 * 1000 : backoffMs);
      this.onResult(accountId, {
        ok: false,
        error: err && err.message ? err.message : String(err),
        needsReauth: Boolean(isAuth),
        fetchedAt: Date.now(),
      });
    } finally {
      st.inFlight = false;
    }
  }

  // token 還有 5 分鐘就到期（或已過期）→ 先續期再用。
  // 另外：距上次續期超過 REFRESH_TOKEN_KEEPALIVE_MS → 就算還沒到期也主動續一次（保鮮）。
  async _ensureFreshToken(account, impl) {
    const tokens = account.tokens || {};
    if (!tokens.accessToken) {
      const err = new Error('這個帳號還沒有完成授權');
      err.code = 'AUTH';
      throw err;
    }
    const now = Date.now();
    const st = this._stateOf(account.id);
    const accessOk = now < (tokens.expiresAt || 0) - C.TOKEN_REFRESH_MARGIN_MS;
    const stale = Boolean(tokens.refreshToken) && now - (tokens.refreshedAt || 0) > C.REFRESH_TOKEN_KEEPALIVE_MS;
    const wantKeepalive = accessOk && stale && now >= st.keepaliveNextAt;
    if (accessOk && !wantKeepalive) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) {
      const err = new Error('token 已過期且沒有續期憑證，需要重新授權');
      err.code = 'AUTH';
      throw err;
    }
    // 同一帳號同時只跑一次續期
    if (!this.refreshLocks.has(account.id)) {
      const p = (async () => {
        try {
          const fresh = await impl.refresh(tokens.refreshToken);
          account.tokens = fresh;
          account.needsReauth = false;
          st.keepaliveNextAt = 0;
          this.onAccountUpdated(account);
          this.onEvent(account.id, wantKeepalive ? 'refresh_ok_keepalive' : 'refresh_ok', '');
          return fresh.accessToken;
        } catch (err) {
          if (err && err.definitive) {
            // 服務端明講這條授權已失效（invalid_grant／401／403）→ 真的要重新登入
            const authErr = new Error(`授權已失效，需要重新授權（${err.message}）`);
            authErr.code = 'AUTH';
            throw authErr;
          }
          // 其他（連不上、逾時、5xx、格式問題）→ 暫時性：保留舊憑證，稍後再試
          if (wantKeepalive) {
            // 保鮮失敗但舊 token 還能用：先繼續用，一小時後再試保鮮
            st.keepaliveNextAt = Date.now() + C.KEEPALIVE_RETRY_MS;
            this.onEvent(account.id, 'keepalive_fail_transient', err.message);
            return tokens.accessToken;
          }
          this.onEvent(account.id, 'refresh_fail_transient', err.message);
          const tmp = new Error(`憑證續期暫時失敗，稍後會自動重試（${err.message}）`);
          tmp.code = 'TRANSIENT';
          throw tmp;
        } finally {
          this.refreshLocks.delete(account.id);
        }
      })();
      this.refreshLocks.set(account.id, p);
    }
    return this.refreshLocks.get(account.id);
  }
}

module.exports = { UsagePoller };

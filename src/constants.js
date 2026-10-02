'use strict';

// ============================================================
// Claude OAuth / API 相關常數
// 這套流程與 Claude Code CLI 的登入方式相同（社群工具通用做法）。
// 若未來 Anthropic 調整端點，改這一個檔案即可。
// ============================================================

module.exports = {
  // Claude Code 公開的 OAuth client id（所有同類工具都用這一組）
  CLAUDE_CLIENT_ID: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',

  // 使用者在瀏覽器裡登入、同意授權的頁面
  CLAUDE_AUTHORIZE_URL: 'https://claude.ai/oauth/authorize',

  // 授權完成後，顯示「授權碼」的回跳頁（使用者從這頁複製授權碼）
  CLAUDE_REDIRECT_URI: 'https://platform.claude.com/oauth/code/callback',

  // 用授權碼換 token / 用 refresh token 續期的端點。
  // 主要端點是 platform.claude.com，舊的 console.anthropic.com 作為備援。
  CLAUDE_TOKEN_URLS: [
    'https://platform.claude.com/v1/oauth/token',
    'https://console.anthropic.com/v1/oauth/token',
  ],

  // 目前 Claude Code 申請的 scope 組合（保持一致，避免被拒絕）。
  // 若授權頁出現 scope 相關錯誤，可改用舊組合：
  //   'org:create_api_key user:profile user:inference'
  CLAUDE_SCOPES: 'user:profile user:inference user:sessions:claude_code user:mcp_servers',

  // 用量與帳號資訊端點（OAuth token 專用 API）
  CLAUDE_USAGE_URL: 'https://api.anthropic.com/api/oauth/usage',
  CLAUDE_PROFILE_URL: 'https://api.anthropic.com/api/oauth/profile',

  // 必要標頭：
  // - anthropic-beta: OAuth token 存取這些端點時必帶
  // - User-Agent: 用量端點依 UA 分流；claude-code 形式的 UA 才有寬鬆的速率限制
  CLAUDE_BETA_HEADER: 'oauth-2025-04-20',
  CLAUDE_USER_AGENT: 'claude-code/2.0.62',

  // ============================================================
  // OpenAI Codex（ChatGPT 訂閱額度）相關常數
  // 與 Codex CLI 的「Sign in with ChatGPT」同一套官方 OAuth 流程。
  // ============================================================

  // Codex CLI 公開的 OAuth client id
  OPENAI_CLIENT_ID: 'app_EMoamEEZ73f0CkXaXp7hrann',
  OPENAI_AUTHORIZE_URL: 'https://auth.openai.com/oauth/authorize',
  OPENAI_TOKEN_URL: 'https://auth.openai.com/oauth/token',
  // Codex 的回跳是本機小伺服器（登入完成自動接收，不用貼碼）；埠號固定 1455
  OPENAI_CALLBACK_PORT: 1455,
  OPENAI_CALLBACK_PATH: '/auth/callback',
  OPENAI_SCOPES: 'openid profile email offline_access',
  // Codex 用量端點（ChatGPT 訂閱制的 5 小時窗 / 週窗百分比）
  OPENAI_USAGE_URL: 'https://chatgpt.com/backend-api/wham/usage',
  OPENAI_USER_AGENT: 'ai-usage-monitor/1.0 (codex-status)',

  // token 快到期前多久就先續期（毫秒）
  TOKEN_REFRESH_MARGIN_MS: 5 * 60 * 1000,

  // refresh token「保鮮」：就算 access token 還沒到期，距上次續期超過這麼久就主動續一次，
  // 讓授權鏈一直活著。Codex 的 access token 可用約 10 天、官方 CLI 自己是 8 天沒續就主動續，
  // 這裡抓 6 天留餘裕。Claude 的 access token 只有 8 小時，本來就天天在續，不受影響。
  REFRESH_TOKEN_KEEPALIVE_MS: 6 * 24 * 3600 * 1000,

  // 保鮮續期若只是暫時失敗（網路、伺服器 5xx），多久後再試一次
  KEEPALIVE_RETRY_MS: 60 * 60 * 1000,

  // token 端點回這些 error 代碼＝授權真的失效（要重新登入）；其他失敗都當暫時性，保留舊憑證稍後重試
  OAUTH_DEFINITIVE_ERRORS: ['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied', 'refresh_token_reused', 'token_revoked'],

  // 用量輪詢預設間隔（分鐘）與可選項
  DEFAULT_REFRESH_MINUTES: 5,
  REFRESH_CHOICES: [1, 3, 5, 10, 15, 30],

  // fetch 逾時（毫秒）
  FETCH_TIMEOUT_MS: 15000,
  // 整次抓取（含續期）的硬上限；超過就當暫時失敗退避重試
  FETCH_HARD_TIMEOUT_MS: 60 * 1000,
  // 看門狗：inFlight 卡超過這麼久就強制解鎖（避免某個帳號永遠不再更新）
  FETCH_STUCK_MS: 3 * 60 * 1000,
};

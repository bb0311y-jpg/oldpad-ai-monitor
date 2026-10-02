'use strict';

const C = require('../constants');

// ============================================================
// OpenAI Codex（ChatGPT 訂閱）用量來源：
//   GET https://chatgpt.com/backend-api/wham/usage
// 回傳整理成與 Claude 相同的 bucket 格式。
// 社群觀察到的回應欄位有幾種寫法，全部防禦性解析：
//   rate_limit.primary / primary_window，used_percent / usedPercent，
//   resets_at(ISO) / reset_at(unix 秒) / reset_after_seconds，
//   window_minutes / limit_window_seconds，additional_rate_limits[]…
// ============================================================

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.code = 'AUTH';
  }
}

function num(...candidates) {
  for (const v of candidates) {
    // 注意：Number(null) === 0，所以 null/undefined/空字串要先跳過
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// 把各種重置時間寫法統一成 ISO 字串
function pickResetsAt(o) {
  if (!o || typeof o !== 'object') return null;
  const direct = o.resets_at ?? o.reset_at ?? o.resetAt ?? o.resetsAt ?? null;
  if (typeof direct === 'string' && direct) return direct;
  if (Number.isFinite(Number(direct)) && Number(direct) > 0) {
    const n = Number(direct);
    // 可能是 unix 秒或毫秒
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  const after = num(o.reset_after_seconds, o.resetAfterSeconds, o.resets_in_seconds);
  if (after !== null) return new Date(Date.now() + after * 1000).toISOString();
  return null;
}

function pickWindowSeconds(o) {
  if (!o || typeof o !== 'object') return null;
  const sec = num(o.limit_window_seconds, o.limitWindowSeconds, o.windowSeconds, o.window_seconds);
  if (sec !== null) return sec;
  const min = num(o.window_minutes, o.windowMinutes);
  if (min !== null) return min * 60;
  return null;
}

function pickUsedPercent(o) {
  if (!o || typeof o !== 'object') return null;
  const used = num(o.used_percent, o.usedPercent, o.usage_percent);
  if (used !== null) return used;
  const left = num(o.remaining_percent, o.remainingPercent, o.left_percent);
  if (left !== null) return 100 - left;
  return null;
}

function windowLabel(windowSeconds, fallbackKind) {
  if (windowSeconds) {
    const hours = Math.round(windowSeconds / 3600);
    if (hours >= 24 * 6 && hours <= 24 * 8) return { kind: 'weekly_all', label: '本週用量（整體）', short: '週' };
    if (hours >= 1 && hours < 24) return { kind: 'session', label: `目前 Session（${hours} 小時）`, short: `${hours}h` };
    const days = Math.round(hours / 24);
    return { kind: 'other', label: `${days} 天額度`, short: `${days}d` };
  }
  // 沒給窗長就照位置猜：primary=Session、secondary=週
  return fallbackKind === 'primary'
    ? { kind: 'session', label: '目前 Session（5 小時）', short: '5h' }
    : { kind: 'weekly_all', label: '本週用量（整體）', short: '週' };
}

function normalizeUsage(raw) {
  const buckets = [];
  const rl = raw?.rate_limit || raw?.rate_limits || raw || {};

  const pushWindow = (winObj, fallbackKind, forcedLabel) => {
    if (!winObj || typeof winObj !== 'object') return;
    const percent = pickUsedPercent(winObj);
    if (percent === null) return;
    const resetsAt = pickResetsAt(winObj);
    const meta = forcedLabel || windowLabel(pickWindowSeconds(winObj), fallbackKind);
    buckets.push({
      kind: meta.kind,
      model: meta.model || null,
      label: meta.label,
      short: meta.short,
      percent: Math.max(0, percent),
      resetsAt,
    });
  };

  pushWindow(rl.primary || rl.primary_window || raw?.five_hour_limit, 'primary');
  pushWindow(rl.secondary || rl.secondary_window || raw?.weekly_limit, 'secondary');

  // 分模型／具名的額外限額（例如 Codex Spark）
  const extras = raw?.additional_rate_limits;
  if (Array.isArray(extras)) {
    for (const item of extras) {
      if (!item || typeof item !== 'object') continue;
      const name = item.title || item.name || item.id || '額外額度';
      const winObj = item.rate_limit || item.window || item;
      pushWindow(winObj, 'secondary', {
        kind: 'weekly_scoped',
        model: String(name),
        label: `額度（${name}）`,
        short: String(name),
      });
    }
  }
  return buckets;
}

// ---- Credits：ChatGPT 的用量點數（超過方案額度後可扣）＋速率重置券 ----
function fmtInt(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function normalizeCredits(raw) {
  const c = raw && raw.credits && typeof raw.credits === 'object' ? raw.credits : null;
  const resets = raw && raw.rate_limit_reset_credits && typeof raw.rate_limit_reset_credits === 'object' ? raw.rate_limit_reset_credits : null;
  if (!c && !resets) return null;
  const items = [];
  let level = null;
  if (c) {
    let text;
    if (c.unlimited) text = '無限';
    else if (!c.has_credits) text = '無';
    else {
      // 回應裡還有 approx_local_messages（OpenAI 估這些點數約可再發幾則訊息的範圍），
      // 數字範圍太寬又占版面，不顯示；原始值仍在 debug 檔裡
      const bal = num(c.balance);
      text = bal === null ? '有' : fmtInt(bal);
    }
    if (c.overage_limit_reached) {
      text += '・已達上限';
      level = 'hot';
    }
    items.push({ name: '點數', text });
  }
  const n = resets ? num(resets.available_count) : null;
  if (n !== null) items.push({ name: '重置券', text: `${n} 張` });
  return { label: 'Credits', items, percent: null, level };
}

async function fetchUsage(accessToken, accountId) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'User-Agent': C.OPENAI_USER_AGENT,
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;

  const res = await fetch(C.OPENAI_USAGE_URL, {
    headers,
    signal: AbortSignal.timeout(C.FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) throw new AuthError(`授權已失效（HTTP ${res.status}）`);
  if (res.status === 429) {
    const err = new Error('伺服器暫時限流（429），稍後會自動重試');
    err.code = 'RATE_LIMIT';
    throw err;
  }
  if (!res.ok) throw new Error(`伺服器回應 HTTP ${res.status}`);
  const raw = await res.json();
  return { buckets: normalizeUsage(raw), credits: normalizeCredits(raw), raw };
}

module.exports = { fetchUsage, normalizeUsage, normalizeCredits, AuthError };

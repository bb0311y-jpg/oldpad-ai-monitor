'use strict';

const C = require('../constants');

// ============================================================
// Claude 用量資料來源：
//   GET /api/oauth/usage   → 目前各種額度的使用百分比與重置時間
//   GET /api/oauth/profile → 帳號 email（用來標示是哪個帳號）
//
// 回傳統一整理成 bucket 陣列：
//   { kind: 'session' | 'weekly_all' | 'weekly_scoped' | 'other',
//     model: 'Fable' (weekly_scoped 才有),
//     label: '顯示名稱', percent: 0-100, resetsAt: ISO 字串或 null }
// ============================================================

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.code = 'AUTH';
  }
}

function authHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-beta': C.CLAUDE_BETA_HEADER,
    'User-Agent': C.CLAUDE_USER_AGENT,
    Accept: 'application/json',
  };
}

async function getJson(url, accessToken) {
  const res = await fetch(url, {
    headers: authHeaders(accessToken),
    signal: AbortSignal.timeout(C.FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    throw new AuthError(`授權已失效（HTTP ${res.status}）`);
  }
  if (res.status === 429) {
    const err = new Error('伺服器暫時限流（429），稍後會自動重試');
    err.code = 'RATE_LIMIT';
    throw err;
  }
  if (!res.ok) {
    throw new Error(`伺服器回應 HTTP ${res.status}`);
  }
  return res.json();
}

// ---- 把 API 回應整理成統一的 bucket 陣列 --------------------

function num(...candidates) {
  for (const v of candidates) {
    // 注意：Number(null) === 0，所以 null/undefined/空字串要先跳過
    if (v === null || v === undefined || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickResetsAt(obj) {
  return obj.resets_at || obj.reset_at || obj.resetsAt || null;
}

function prettyModelName(rawKey) {
  // ex: 'seven_day_opus' → 'Opus'；'seven_day_sonnet_4' → 'Sonnet 4'
  return rawKey
    .replace(/^seven_day_/, '')
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function bucketSortWeight(b) {
  if (b.kind === 'session') return 0;
  if (b.kind === 'weekly_all') return 1;
  if (b.kind === 'weekly_scoped') return 2;
  return 3;
}

function labelFor(kind, model) {
  if (kind === 'session') return '目前 Session（5 小時）';
  if (kind === 'weekly_all') return '本週用量（全部模型）';
  if (kind === 'weekly_scoped') return `本週用量（${model}）`;
  return model || '其他額度';
}

function normalizeUsage(raw) {
  const buckets = [];
  const seen = new Set();

  const push = (kind, model, percent, resetsAt) => {
    if (percent === null) return;
    const dedupeKey = `${kind}|${(model || '').toLowerCase()}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    buckets.push({
      kind,
      model: model || null,
      label: labelFor(kind, model),
      percent: Math.max(0, percent),
      resetsAt: resetsAt || null,
    });
  };

  // 1) 新版自我描述的 limits 陣列（優先採用；分模型額度如 Fable 會出現在這裡）
  if (Array.isArray(raw?.limits)) {
    for (const item of raw.limits) {
      if (!item || typeof item !== 'object') continue;
      const percent = num(item.percent, item.utilization, item.used_percent);
      const resetsAt = pickResetsAt(item);
      let kind = item.kind || item.type || 'other';
      let model =
        item?.scope?.model?.display_name ||
        item?.scope?.model?.name ||
        item?.model?.display_name ||
        item?.model ||
        null;
      if (kind === 'weekly_scoped' && !model) model = '特定模型';
      if (!['session', 'weekly_all', 'weekly_scoped'].includes(kind)) {
        // 沒看過的種類也照樣顯示，名稱直接用它的 kind
        push('other', String(kind), percent, resetsAt);
        continue;
      }
      push(kind, model, percent, resetsAt);
    }
  }

  // 2) 傳統頂層欄位（five_hour / seven_day / seven_day_xxx），作為補充或舊版備援。
  //    只認有 utilization 欄位的物件——spend、extra_usage 這類非額度欄位不能混進來。
  const legacyMap = { five_hour: ['session', null], seven_day: ['weekly_all', null] };
  for (const [key, value] of Object.entries(raw || {})) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const percent = num(value.utilization);
    if (percent === null) continue;
    const resetsAt = pickResetsAt(value);
    if (legacyMap[key]) {
      push(legacyMap[key][0], legacyMap[key][1], percent, resetsAt);
    } else if (key.startsWith('seven_day_')) {
      push('weekly_scoped', prettyModelName(key), percent, resetsAt);
    } else {
      push('other', key, percent, resetsAt);
    }
  }

  buckets.sort((a, b) => bucketSortWeight(a) - bucketSortWeight(b) || String(a.model).localeCompare(String(b.model)));
  return buckets;
}

async function fetchUsage(accessToken) {
  const raw = await getJson(C.CLAUDE_USAGE_URL, accessToken);
  return { buckets: normalizeUsage(raw), raw };
}

async function fetchProfile(accessToken) {
  const raw = await getJson(C.CLAUDE_PROFILE_URL, accessToken);
  const email =
    raw?.account?.email ||
    raw?.account?.email_address ||
    raw?.email ||
    null;
  const name =
    raw?.account?.full_name ||
    raw?.account?.display_name ||
    null;
  return { email, name, raw };
}

module.exports = { fetchUsage, fetchProfile, normalizeUsage, AuthError };

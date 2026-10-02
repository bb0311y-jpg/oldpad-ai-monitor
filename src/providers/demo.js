'use strict';

// 示範帳號資料來源：產生會隨時間緩慢變化的假數據，
// 讓使用者（或開發時）不必先授權真帳號就能預覽介面。

function wave(seed, periodMs, min, max) {
  const t = Date.now() / periodMs + seed;
  const s = (Math.sin(t * Math.PI * 2) + 1) / 2; // 0..1
  return min + s * (max - min);
}

function nextResetIso(intervalMs, offsetMs) {
  const now = Date.now();
  const next = Math.ceil((now - offsetMs) / intervalMs) * intervalMs + offsetMs;
  return new Date(next).toISOString();
}

async function fetchUsage(_token, seed = 1) {
  const fiveHours = 5 * 3600 * 1000;
  const week = 7 * 24 * 3600 * 1000;
  const buckets = [
    {
      kind: 'session',
      model: null,
      label: '目前 Session（5 小時）',
      percent: Math.round(wave(seed, 40 * 60 * 1000, 8, 92) * 10) / 10,
      resetsAt: nextResetIso(fiveHours, seed * 37 * 60 * 1000),
    },
    {
      kind: 'weekly_all',
      model: null,
      label: '本週用量（全部模型）',
      percent: Math.round(wave(seed + 0.3, 90 * 60 * 1000, 20, 75) * 10) / 10,
      resetsAt: nextResetIso(week, seed * 11 * 3600 * 1000),
    },
    {
      kind: 'weekly_scoped',
      model: 'Fable',
      label: '本週用量（Fable）',
      percent: Math.round(wave(seed + 0.6, 70 * 60 * 1000, 5, 60) * 10) / 10,
      resetsAt: nextResetIso(week, seed * 11 * 3600 * 1000),
    },
  ];
  return { buckets, raw: { demo: true } };
}

module.exports = { fetchUsage };

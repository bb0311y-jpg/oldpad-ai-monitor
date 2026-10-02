'use strict';

// 開發用：不開 Electron 視窗，直接用示範帳號＋真實系統指標跑區網儀表板。
//   node scripts/preview-dashboard.js [埠號]
//   node scripts/preview-dashboard.js 3899 --proxy=http://127.0.0.1:3801
//     → 資料改抓「正式程式」的 /api/state（真帳號），網頁檔用開發資料夾的，改版面時最好用
// 用途：改儀表板網頁時快速預覽；也能拿 iPad 直接連來看效果。

const { LanServer, DEFAULT_PORT } = require('../src/lan-server');
const { SystemMetrics } = require('../src/sysmetrics');
const demo = require('../src/providers/demo');

const port = Number(process.argv[2]) || DEFAULT_PORT;
const proxyArg = process.argv.find((a) => a.startsWith('--proxy='));
const proxyUrl = proxyArg ? proxyArg.slice('--proxy='.length).replace(/\/$/, '') + '/api/state' : null;
let proxied = null; // 最近一次從正式程式抓到的狀態
const metrics = new SystemMetrics();
const accounts = [
  { id: 'demo-1', provider: 'claude', label: 'work@example.com', email: null, needsReauth: false, planType: 'max' },
  { id: 'demo-2', provider: 'codex', label: 'ChatGPT Plus', email: null, needsReauth: false, planType: 'plus' },
  { id: 'demo-3', provider: 'claude', label: '備用帳號', email: null, needsReauth: false, planType: null },
  { id: 'demo-4', provider: 'claude', label: 'third@example.com', email: null, needsReauth: false, planType: 'pro' },
  { id: 'demo-5', provider: 'claude', label: 'second@example.com', email: null, needsReauth: false, planType: 'max' },
  { id: 'demo-6', provider: 'codex', label: 'ChatGPT Pro', email: null, needsReauth: false, planType: 'pro' },
];
// --accounts=N 只保留前 N 個示範帳號（截圖不同版面用）
const limitArg = process.argv.find((a) => a.startsWith('--accounts='));
if (limitArg) accounts.length = Math.max(0, Math.min(accounts.length, Number(limitArg.slice('--accounts='.length)) || 0));
const usage = {};

async function refresh() {
  for (const [i, a] of accounts.entries()) {
    if (a.needsReauth) continue;
    const r = await demo.fetchUsage(null, (i + 1) * 1.7);
    let buckets = r.buckets;
    if (a.provider === 'codex') buckets = r.buckets.slice(1, 2);
    usage[a.id] = { ok: true, buckets, fetchedAt: Date.now() };
  }
}

function pullProxy() {
  require('http')
    .get(proxyUrl, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          proxied = JSON.parse(body);
        } catch {
          /* 正式程式還沒起來就先用示範資料 */
        }
      });
    })
    .on('error', () => {});
}

let order = []; // 儀表板拖曳排序後的順序（預覽只放記憶體）
const server = new LanServer({
  getState: () =>
    proxied
      ? { ...proxied, version: proxied.version + '-preview' }
      : { version: 'preview', now: Date.now(), accounts, usage, order, system: { ...metrics.snapshot(), host: 'DEMO-PC' } },
  onReorder: (ids) => { order = ids; console.log('新順序：' + ids.join(' > ')); },
  log: (m) => console.log(m),
});

refresh().then(() => server.start(port)).then(() => {
  setInterval(refresh, 60 * 1000);
  if (proxyUrl) {
    pullProxy();
    setInterval(pullProxy, 2000);
    console.log(`資料來源：${proxyUrl}`);
  }
  console.log('預覽中，Ctrl+C 結束');
});

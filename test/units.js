'use strict';

// 純 Node 可跑的單元測試：node test/units.js
// 驗證不需要開視窗就能測的核心邏輯。

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildAuthorization, parsePastedCode } = require('../src/oauth');
const oauthOpenai = require('../src/oauth-openai');
const { normalizeUsage } = require('../src/providers/claude');
const codex = require('../src/providers/codex');
const demo = require('../src/providers/demo');
const { Store } = require('../src/store');
const { gaugePng } = require('../src/icon');
const C = require('../src/constants');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    process.exitCode = 1;
  }
}

console.log('OAuth：');

test('授權網址包含所有必要參數，且 PKCE challenge 正確', () => {
  const { url, verifier, state } = buildAuthorization();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, C.CLAUDE_AUTHORIZE_URL);
  assert.equal(u.searchParams.get('client_id'), C.CLAUDE_CLIENT_ID);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('redirect_uri'), C.CLAUDE_REDIRECT_URI);
  assert.equal(u.searchParams.get('scope'), C.CLAUDE_SCOPES);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('code'), 'true');
  assert.equal(u.searchParams.get('state'), state);
  const expected = crypto.createHash('sha256').update(verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(u.searchParams.get('code_challenge'), expected);
});

test('每次授權的 verifier / state 都不同', () => {
  const a = buildAuthorization();
  const b = buildAuthorization();
  assert.notEqual(a.verifier, b.verifier);
  assert.notEqual(a.state, b.state);
});

test('授權碼解析：code#state 形式', () => {
  const { code, echoedState } = parsePastedCode('  abc123#st_456  ');
  assert.equal(code, 'abc123');
  assert.equal(echoedState, 'st_456');
});

test('授權碼解析：沒有 # 也能接受', () => {
  const { code, echoedState } = parsePastedCode('onlycode');
  assert.equal(code, 'onlycode');
  assert.equal(echoedState, '');
});

test('授權碼解析：空字串要報錯', () => {
  assert.throws(() => parsePastedCode('   '));
});

console.log('用量資料解析：');

test('新版 limits 陣列（含 Fable 分模型額度）', () => {
  const buckets = normalizeUsage({
    limits: [
      { kind: 'session', percent: 42.5, resets_at: '2026-07-15T18:00:00Z' },
      { kind: 'weekly_all', percent: 7, resets_at: '2026-07-18T08:00:00Z' },
      { kind: 'weekly_scoped', percent: 12, resets_at: '2026-07-18T08:00:00Z', scope: { model: { display_name: 'Fable' } } },
    ],
  });
  assert.equal(buckets.length, 3);
  assert.equal(buckets[0].kind, 'session');
  assert.equal(buckets[0].percent, 42.5);
  assert.equal(buckets[1].kind, 'weekly_all');
  assert.equal(buckets[2].model, 'Fable');
  assert.ok(buckets[2].label.includes('Fable'));
});

test('舊版頂層欄位（five_hour / seven_day / seven_day_opus）', () => {
  const buckets = normalizeUsage({
    five_hour: { utilization: 42.0, resets_at: '2026-02-27T18:00:00+00:00' },
    seven_day: { utilization: 7.0, resets_at: '2026-03-06T08:00:00+00:00' },
    seven_day_opus: { utilization: 3.0, resets_at: '2026-03-06T08:00:00+00:00' },
  });
  assert.equal(buckets.length, 3);
  assert.deepEqual(buckets.map((b) => b.kind), ['session', 'weekly_all', 'weekly_scoped']);
  assert.equal(buckets[2].model, 'Opus');
});

test('兩種格式同時存在時不會重複顯示', () => {
  const buckets = normalizeUsage({
    limits: [{ kind: 'session', percent: 40, resets_at: null }],
    five_hour: { utilization: 40, resets_at: null },
    seven_day: { utilization: 10, resets_at: null },
  });
  assert.equal(buckets.filter((b) => b.kind === 'session').length, 1);
  assert.equal(buckets.length, 2);
});

test('沒看過的欄位也能顯示（未來新模型自動出現）', () => {
  const buckets = normalizeUsage({
    seven_day_fable_ultra: { utilization: 5, resets_at: null },
  });
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].kind, 'weekly_scoped');
  assert.equal(buckets[0].model, 'Fable Ultra');
});

test('空回應不會壞掉', () => {
  assert.deepEqual(normalizeUsage({}), []);
  assert.deepEqual(normalizeUsage(null), []);
});

test('真實回應（2026-07）：spend / extra_usage / null 欄位不會變成用量條', () => {
  // 依 2026-07-15 實際觀測到的 Claude 回應結構（已去識別化）
  const buckets = normalizeUsage({
    five_hour: { utilization: 56, resets_at: '2026-07-15T12:59:59Z', limit_dollars: null },
    seven_day: { utilization: 44, resets_at: '2026-07-17T07:59:59Z', limit_dollars: null },
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    tangelo: null,
    extra_usage: { is_enabled: false, monthly_limit: null, utilization: null, daily: null },
    limits: [
      { kind: 'session', group: 'session', percent: 56, severity: 'normal', resets_at: '2026-07-15T12:59:59Z', scope: null, is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 44, severity: 'normal', resets_at: '2026-07-17T07:59:59Z', scope: null, is_active: false },
      { kind: 'weekly_scoped', group: 'weekly', percent: 60, severity: 'normal', resets_at: '2026-07-17T07:59:59Z', scope: { model: { id: null, display_name: 'Fable' }, surface: null }, is_active: true },
    ],
    spend: { used: { amount_minor: 0 }, limit: null, percent: 0, severity: 'normal', enabled: false },
  });
  assert.equal(buckets.length, 3, `應該剛好 3 條，實際 ${buckets.length}：${buckets.map((b) => b.label).join('、')}`);
  assert.ok(!buckets.some((b) => /spend|extra_usage/i.test(b.label)));
  assert.deepEqual(buckets.map((b) => b.percent), [56, 44, 60]);
});

test('示範資料來源產出三個 bucket', async () => {
  const { buckets } = await demo.fetchUsage(null, 1);
  assert.equal(buckets.length, 3);
  buckets.forEach((b) => {
    assert.ok(b.percent >= 0 && b.percent <= 100);
    assert.ok(b.resetsAt);
  });
});

console.log('Codex（OpenAI）：');

test('OpenAI 授權網址參數正確、PKCE challenge 正確', () => {
  const { url, verifier, state } = oauthOpenai.buildAuthorization();
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, C.OPENAI_AUTHORIZE_URL);
  assert.equal(u.searchParams.get('client_id'), C.OPENAI_CLIENT_ID);
  assert.equal(u.searchParams.get('redirect_uri'), `http://localhost:${C.OPENAI_CALLBACK_PORT}${C.OPENAI_CALLBACK_PATH}`);
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), C.OPENAI_SCOPES);
  assert.equal(u.searchParams.get('state'), state);
  const expected = crypto.createHash('sha256').update(verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(u.searchParams.get('code_challenge'), expected);
});

test('Codex 用量解析：rate_limit.primary/secondary（ISO 重置時間）', () => {
  const buckets = codex.normalizeUsage({
    rate_limit: {
      primary: { used_percent: 28.0, window_minutes: 300, resets_at: '2026-07-15T14:15:00Z' },
      secondary: { used_percent: 59.0, window_minutes: 10080, resets_at: '2026-07-21T09:00:00Z' },
    },
  });
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].kind, 'session');
  assert.equal(buckets[0].percent, 28);
  assert.ok(buckets[0].label.includes('5 小時'));
  assert.equal(buckets[1].kind, 'weekly_all');
  assert.equal(buckets[1].resetsAt, '2026-07-21T09:00:00Z');
});

test('Codex 用量解析：primary_window 變體（unix 秒＋limit_window_seconds）', () => {
  const resetUnix = Math.floor(Date.now() / 1000) + 3600;
  const buckets = codex.normalizeUsage({
    rate_limit: {
      primary_window: { used_percent: 12.5, limit_window_seconds: 18000, reset_at: resetUnix },
      secondary_window: { used_percent: 80, limit_window_seconds: 604800, reset_after_seconds: 86400 },
    },
  });
  assert.equal(buckets.length, 2);
  assert.equal(buckets[0].percent, 12.5);
  assert.equal(new Date(buckets[0].resetsAt).getTime(), resetUnix * 1000);
  assert.equal(buckets[1].kind, 'weekly_all');
  assert.ok(Math.abs(new Date(buckets[1].resetsAt).getTime() - (Date.now() + 86400 * 1000)) < 5000);
});

test('Codex 用量解析：additional_rate_limits 具名額度', () => {
  const buckets = codex.normalizeUsage({
    rate_limit: { primary: { used_percent: 10, window_minutes: 300 } },
    additional_rate_limits: [
      { title: 'Codex Spark', rate_limit: { used_percent: 33, window_minutes: 300, resets_at: '2026-07-15T20:00:00Z' } },
    ],
  });
  assert.equal(buckets.length, 2);
  assert.equal(buckets[1].kind, 'weekly_scoped');
  assert.equal(buckets[1].model, 'Codex Spark');
  assert.equal(buckets[1].percent, 33);
});

test('Codex 真實回應（2026-07，僅週額度）：一條週用量、unix 重置時間正確', () => {
  // 依 2026-07-15 實際觀測：OpenAI 暫時移除 5 小時窗，只回一個 7 天的 primary_window
  const buckets = codex.normalizeUsage({
    plan_type: 'plus',
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: 5, limit_window_seconds: 604800, reset_after_seconds: 604474, reset_at: 1784724856 },
      secondary_window: null,
    },
    code_review_rate_limit: null,
    additional_rate_limits: null,
    credits: { has_credits: false, balance: '0' },
    rate_limit_reached_type: null,
  });
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].kind, 'weekly_all');
  assert.equal(buckets[0].percent, 5);
  assert.equal(new Date(buckets[0].resetsAt).getTime(), 1784724856 * 1000);
});

test('Codex 用量解析：只有 remaining_percent 也能反推', () => {
  const buckets = codex.normalizeUsage({
    rate_limit: { primary: { remaining_percent: 72, window_minutes: 300 } },
  });
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].percent, 28);
});

test('Codex JWT 解析：帳號 id / email / 方案', () => {
  const payload = {
    email: 'someone@example.com',
    'https://api.openai.com/auth': { chatgpt_account_id: 'acc-123', chatgpt_plan_type: 'plus' },
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const fakeJwt = `x.${b64}.y`;
  const identity = oauthOpenai.extractIdentity({ access_token: fakeJwt, id_token: fakeJwt });
  assert.equal(identity.accountId, 'acc-123');
  assert.equal(identity.email, 'someone@example.com');
  assert.equal(identity.planType, 'plus');
});

console.log('本地儲存：');

test('帳號 / 設定 / 快取 存取往返（純 Node 明文路徑）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-mon-test-'));
  const store = new Store(dir);
  const accounts = [{ id: 'a1', provider: 'claude', label: '測試', tokens: { accessToken: 'x' } }];
  store.saveAccounts(accounts);
  assert.deepEqual(store.loadAccounts(), accounts);
  store.saveSettings({ opacity: 0.8 });
  assert.equal(store.loadSettings({ opacity: 1, compact: false }).opacity, 0.8);
  assert.equal(store.loadSettings({ opacity: 1, compact: false }).compact, false);
  store.saveCache({ a1: { ok: true } });
  assert.deepEqual(store.loadCache(), { a1: { ok: true } });
  store.saveDebugRaw('a1', { hello: 1 });
  assert.ok(fs.existsSync(path.join(dir, 'debug', 'last-usage-a1.json')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ephemeral 模式不寫任何檔案', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-mon-eph-'));
  const store = new Store(dir, { ephemeral: true });
  store.saveAccounts([{ id: 'x' }]);
  store.saveCache({ x: 1 });
  assert.deepEqual(store.loadAccounts(), [{ id: 'x' }]);
  assert.equal(fs.readdirSync(dir).length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('圖示產生器：');

test('產出的 PNG 有正確簽名與尺寸標記', () => {
  const png = gaugePng(32);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 32); // IHDR width
  assert.equal(png.readUInt32BE(20), 32); // IHDR height
  assert.ok(png.length > 200, 'PNG 內容不應該是空的');
});

console.log('版面計算（視窗可拉大縮小）：');

const Layout = require('../renderer/layout');
const flatMeasure = (h) => () => h;

test('預設雙欄寬度 728 → 2 欄、完整層級、zoom 約 1', () => {
  const r = Layout.computeLayout({ innerW: 728, innerH: 460, columnsSetting: 2, autoHeight: true, measure: flatMeasure(400) });
  assert.equal(r.cols, 2);
  assert.equal(r.tier, 'normal');
  assert.ok(Math.abs(r.zoom - 1) < 0.03, `zoom=${r.zoom}`);
  assert.equal(r.height, Math.ceil(400 * r.zoom + 24 + 1));
});

test('視窗變窄 → 先等比縮小，再窄就降到緊湊、精簡層級', () => {
  const at = (w) => Layout.computeLayout({ innerW: w, innerH: 460, columnsSetting: 1, autoHeight: true, measure: flatMeasure(400) });
  const wide = at(372); // 單欄預設寬 → zoom 剛好 1
  assert.equal(wide.tier, 'normal');
  assert.equal(wide.zoom, 1);
  const mid = at(300); // 每欄 276px：低於 320 → 緊湊
  assert.equal(mid.tier, 'tight');
  const narrow = at(240); // 216px：低於 260 → 精簡
  assert.equal(narrow.tier, 'compact');
  assert.ok(narrow.zoom < 1 && narrow.zoom >= Layout.ZOOM_MIN);
  const tiny = at(120);
  assert.equal(tiny.zoom, Layout.ZOOM_MIN, '縮到底就不再縮');
});

test('固定欄數時視窗拉寬 → 內容等比放大，但有上限', () => {
  const r = Layout.computeLayout({ innerW: 1400, innerH: 600, columnsSetting: 2, autoHeight: true, measure: flatMeasure(400) });
  assert.equal(r.cols, 2);
  assert.ok(r.zoom > 1.5 && r.zoom <= Layout.ZOOM_MAX, `zoom=${r.zoom}`);
});

test('自動欄數：拉寬是多排幾欄而不是放大字', () => {
  const at = (w) => Layout.computeLayout({ innerW: w, innerH: 600, columnsSetting: 0, autoHeight: true, measure: flatMeasure(400) });
  assert.equal(at(300).cols, 1);
  assert.equal(at(760).cols, 2);
  assert.equal(at(1120).cols, 3);
  assert.ok(at(1120).zoom <= 1);
  assert.equal(at(3000).cols, 4, '最多 4 欄');
});

test('精簡模式按鈕 → 一律精簡層級，在預設精簡寬度下 zoom = 1', () => {
  const r = Layout.computeLayout({ innerW: 576, innerH: 400, columnsSetting: 2, forceCompact: true, autoHeight: true, measure: flatMeasure(300) });
  assert.equal(r.tier, 'compact');
  assert.equal(r.zoom, 1);
});

test('手動高度：放不下時先降密度，再等比縮小，縮到底才捲動', () => {
  // 不同層級量到的自然高度：越精簡越矮
  const heights = { normal: 900, tight: 700, compact: 500 };
  const measure = (tier) => heights[tier];
  const a = Layout.computeLayout({ innerW: 728, innerH: 600, columnsSetting: 2, autoHeight: false, measure });
  assert.equal(a.tier, 'tight', '600 高放不下 900 → 降一級到緊湊（700×0.82）');
  assert.ok(a.zoom < 1 && a.zoom >= 0.8, `zoom=${a.zoom}`);
  const b = Layout.computeLayout({ innerW: 728, innerH: 300, columnsSetting: 2, autoHeight: false, measure });
  assert.equal(b.tier, 'compact', '300 高 → 降到精簡');
  assert.equal(b.zoom, Layout.ZOOM_MIN, '精簡也放不下 → 縮到底（之後由卡片區捲動）');
  const c = Layout.computeLayout({ innerW: 728, innerH: 1000, columnsSetting: 2, autoHeight: false, measure });
  assert.equal(c.tier, 'normal', '放得下就維持完整層級');
  assert.equal(c.height, null, '手動高度不回傳自動高度');
});

test('面板打開時自動高度至少留面板的最小高度', () => {
  const r = Layout.computeLayout({ innerW: 728, innerH: 300, columnsSetting: 2, autoHeight: true, panelOpen: true, measure: flatMeasure(100) });
  assert.ok(r.height >= 430 * r.zoom + 24, `height=${r.height}`);
});

// ============================================================
// v1.3.0：區網儀表板（iPad 用）與系統指標
// ============================================================

const sysm = require('../src/sysmetrics');
const lan = require('../src/lan-server');
const http = require('http');

console.log('系統指標：');

test('CPU 使用率：由兩次 os.cpus() 快照算出整體與每核心 %', () => {
  const mk = (idle, user) => ({ times: { user, nice: 0, sys: 0, idle, irq: 0 } });
  const prev = [mk(100, 100), mk(100, 100)];
  const next = [mk(150, 150), mk(200, 100)]; // 核心 0：50% 忙；核心 1：0% 忙
  const r = sysm.cpuPercentFromSamples(prev, next);
  assert.equal(r.cores[0], 50);
  assert.equal(r.cores[1], 0);
  assert.equal(r.total, 25);
});

test('CPU 使用率：核心數不一致或沒有前一次快照 → null', () => {
  assert.equal(sysm.cpuPercentFromSamples(null, [{ times: {} }]).total, null);
  assert.equal(sysm.cpuPercentFromSamples([{ times: {} }], [{ times: {} }, { times: {} }]).total, null);
});

test('nvidia-smi 一列 csv → 物件，[N/A] 變 null', () => {
  const g = sysm.parseNvidiaSmi('NVIDIA GeForce RTX 3090 Ti, 50, 13, 2302, 24564, 120.40, 450.00, [N/A], 1860');
  assert.equal(g.name, 'NVIDIA GeForce RTX 3090 Ti');
  assert.equal(g.tempC, 50);
  assert.equal(g.utilPct, 13);
  assert.equal(g.vramUsedMb, 2302);
  assert.equal(g.vramTotalMb, 24564);
  assert.equal(g.powerW, 120.4);
  assert.equal(g.fanPct, null);
  assert.equal(g.clockMhz, 1860);
  assert.equal(sysm.parseNvidiaSmi(''), null, '空輸出 → null');
});

test('LibreHardwareMonitor 樹狀 JSON → CPU 溫度／主機板溫度／風扇', () => {
  const tree = {
    Text: 'Sensor', ImageURL: '', Children: [{
      Text: 'DESKTOP', ImageURL: 'images_icon/computer.png', Children: [
        { Text: 'Intel Core i7', ImageURL: 'images_icon/cpu.png', Children: [
          { Text: 'Temperatures', ImageURL: 'images_icon/temperature.png', Children: [
            { Text: 'CPU Core #1', Value: '61.0 °C', ImageURL: 'images/transparent.png', Children: [] },
            { Text: 'CPU Package', Value: '64.0 °C', ImageURL: 'images/transparent.png', Children: [] },
          ] },
          { Text: 'Load', ImageURL: 'images_icon/load.png', Children: [
            { Text: 'CPU Total', Value: '12.3 %', ImageURL: 'images/transparent.png', Children: [] },
          ] },
        ] },
        { Text: 'ASUS PRIME', ImageURL: 'images_icon/mainboard.png', Children: [
          { Text: 'Nuvoton', ImageURL: 'images_icon/chip.png', Children: [
            { Text: 'Temperatures', ImageURL: 'images_icon/temperature.png', Children: [
              { Text: 'System', Value: '38.0 °C', ImageURL: 'images/transparent.png', Children: [] },
            ] },
            { Text: 'Fans', ImageURL: 'images_icon/fan.png', Children: [
              { Text: 'CPU Fan', Value: '1,204 RPM', ImageURL: 'images/transparent.png', Children: [] },
            ] },
          ] },
        ] },
        { Text: 'Samsung SSD', ImageURL: 'images_icon/nvme.png', Children: [
          { Text: 'Temperatures', ImageURL: 'images_icon/temperature.png', Children: [
            { Text: 'Temperature', Value: '41.0 °C', ImageURL: 'images/transparent.png', Children: [] },
          ] },
        ] },
      ],
    }],
  };
  const r = sysm.parseLhm(tree);
  assert.equal(r.cpuTempC, 64, '優先取 CPU Package');
  assert.equal(r.boardTempC, 38);
  assert.equal(r.diskTemps.length, 1);
  assert.equal(r.diskTemps[0].name, 'Samsung SSD');
  assert.equal(r.boardTemps.length, 1);
  assert.equal(r.fans[0].rpm, 1204, '千分位逗號要能吃');
});

test('LibreHardwareMonitor：同一顆硬碟多個溫度只留第一個、0 rpm 風扇不列、硬碟名縮短', () => {
  const leaf = (t, v) => ({ Text: t, Value: v, ImageURL: 'images/transparent.png', Children: [] });
  const tree = { Text: 'Sensor', ImageURL: '', Children: [{ Text: 'PC', ImageURL: 'images_icon/computer.png', Children: [
    { Text: 'WDC PC SN530 SDBPNPZ-1T00-1032', ImageURL: 'images_icon/nvme.png', Children: [
      { Text: 'Temperatures', ImageURL: 'images_icon/temperature.png', Children: [leaf('Temperature', '47.0 °C'), leaf('Temperature 1', '79.0 °C'), leaf('Temperature 2', '84.0 °C')] },
    ] },
    { Text: 'Board', ImageURL: 'images_icon/mainboard.png', Children: [{ Text: 'Chip', ImageURL: 'images_icon/chip.png', Children: [
      { Text: 'Fans', ImageURL: 'images_icon/fan.png', Children: [leaf('CPU Fan', '1,088 RPM'), leaf('System Fan #1', '0 RPM')] },
    ] }] },
  ] }] };
  const r = sysm.parseLhm(tree);
  assert.equal(r.diskTemps.length, 1);
  assert.equal(r.diskTemps[0].tempC, 47);
  assert.equal(r.diskTemps[0].name, 'SN530');
  assert.deepEqual(r.fans.map((f) => f.name), ['CPU Fan']);
  assert.equal(sysm.shortDiskName('XPG GAMMIX S70 BLADE'), 'GAMMIX S70');
  assert.equal(sysm.shortDiskName('CT1000MX500SSD1 '), 'CT1000MX500SSD1'); // 單一長型號 15 字內整個留
});

test('LibreHardwareMonitor 資料是空的也不會炸', () => {
  const r = sysm.parseLhm({});
  assert.equal(r.cpuTempC, null);
  assert.deepEqual(r.fans, []);
});

console.log('區網儀表板：');

test('只放行私有網段（區網／本機／Tailscale），公網 IP 擋掉', () => {
  for (const ok of ['192.168.11.101', '::ffff:192.168.1.5', '10.0.0.7', '172.20.1.1', '100.85.222.111', '127.0.0.1', '::1']) {
    assert.ok(lan.isPrivateAddress(ok), `${ok} 應放行`);
  }
  for (const bad of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2001:db8::1', '', null]) {
    assert.ok(!lan.isPrivateAddress(bad), `${bad} 應擋掉`);
  }
});

test('Host 標頭：只認 localhost 與私有 IP 字面值，網域名一律擋（防 DNS rebinding）', () => {
  for (const ok of ['192.168.11.101:3801', '127.0.0.1', 'localhost:3801', '[::1]:3801', '100.85.222.111:3801']) {
    assert.ok(lan.isAllowedHost(ok), `${ok} 應放行`);
  }
  for (const bad of ['evil.example.com:3801', '8.8.8.8:3801', '', undefined, 'localhost.evil.com']) {
    assert.ok(!lan.isAllowedHost(bad), `${bad} 應擋掉`);
  }
});

test('nvidia-smi：顯卡名稱含逗號也不會錯位', () => {
  const g = sysm.parseNvidiaSmi('NVIDIA RTX A6000, Ada Generation, 41, 3, 100, 49140, 30.1, 300.0, 30, 210');
  assert.equal(g.name, 'NVIDIA RTX A6000, Ada Generation');
  assert.equal(g.vramTotalMb, 49140);
  assert.equal(g.clockMhz, 210);
});

test('區網網址候選：家用 192.168 排最前面、本機回送不列', () => {
  const list = lan.lanAddresses();
  assert.ok(list.every((a) => a.address !== '127.0.0.1'));
  if (list.length > 1 && list.some((a) => a.address.startsWith('192.168.'))) {
    assert.ok(list[0].address.startsWith('192.168.'));
  }
});

const pending = [];
function testAsync(name, fn) {
  pending.push(
    fn().then(
      () => {
        passed++;
        console.log(`  ✓ ${name}`);
      },
      (err) => {
        console.error(`  ✗ ${name}`);
        console.error(`    ${err.message}`);
        process.exitCode = 1;
      }
    )
  );
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    }).on('error', reject);
  });
}

testAsync('伺服器：/api/state 回 JSON、/ 回網頁、亂路徑 404、關掉後埠釋放', async () => {
  const server = new lan.LanServer({
    getState: () => ({ version: 't', accounts: [{ id: 'a', label: 'x' }], usage: {}, system: { cpu: { pct: 1 } } }),
  });
  const { port } = await server.start(0, '127.0.0.1');
  assert.ok(port > 0);
  const api = await getJson(`http://127.0.0.1:${port}/api/state`);
  assert.equal(api.status, 200);
  assert.equal(JSON.parse(api.body).accounts[0].id, 'a');
  assert.equal(api.headers['cache-control'], 'no-store');
  const page = await getJson(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.ok(page.body.includes('apple-mobile-web-app-capable'), '首頁要有 iOS 全螢幕標記');
  assert.ok((await getJson(`http://127.0.0.1:${port}/app.js`)).body.includes('XMLHttpRequest'));
  assert.equal((await getJson(`http://127.0.0.1:${port}/nope`)).status, 404);
  assert.equal((await getJson(`http://127.0.0.1:${port}/../package.json`)).status, 404, '不能讀資料夾外的檔');
  assert.equal(server.info().hits, 1);
  await server.stop();
  assert.equal(server.info().running, false);
  const again = new lan.LanServer({ getState: () => ({}) });
  await again.start(port, '127.0.0.1'); // 同一埠能再開，代表真的釋放了
  await again.stop();
});

testAsync('伺服器：帶網域名的 Host 被 403，帶 IP 的放行', async () => {
  const server = new lan.LanServer({ getState: () => ({}) });
  const { port } = await server.start(0, '127.0.0.1');
  const req = (host) =>
    new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { Host: host } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
  assert.equal(await req('evil.example.com'), 403);
  assert.equal(await req(`127.0.0.1:${port}`), 200);
  await server.stop();
});

testAsync('伺服器：啟動中立刻 stop → 等 listen 完成再關，不會留下活著的伺服器', async () => {
  const server = new lan.LanServer({ getState: () => ({}) });
  const starting = server.start(0, '127.0.0.1');
  await server.stop(); // 不等 start 完成就關
  await starting.catch(() => {});
  assert.equal(server.info().running, false);
  assert.equal(server.server, null);
});

testAsync('伺服器：getState 丟例外 → 500 而不是整個掛掉', async () => {
  const server = new lan.LanServer({ getState: () => { throw new Error('boom'); } });
  const { port } = await server.start(0, '127.0.0.1');
  const r = await getJson(`http://127.0.0.1:${port}/api/state`);
  assert.equal(r.status, 500);
  assert.equal(JSON.parse(r.body).error, 'boom');
  await server.stop();
});

testAsync('伺服器：埠被占用 → start 拒絕並留下看得懂的錯誤', async () => {
  const a = new lan.LanServer({ getState: () => ({}) });
  const { port } = await a.start(0, '127.0.0.1');
  const b = new lan.LanServer({ getState: () => ({}) });
  await assert.rejects(b.start(port, '127.0.0.1'));
  assert.ok(/占用/.test(b.error), b.error);
  await a.stop();
});

test('硬碟讀寫：wmic CSV（有空行、CRLF）與 PowerShell CSV（有引號）都解析得出來', () => {
  const wmic = '\r\n\r\nNode,DiskReadBytesPersec,Name\r\nPC,123,1 C:\r\nPC,0,_Total\r\n';
  assert.deepEqual(sysm.parseCsv(wmic), [{ Node: 'PC', DiskReadBytesPersec: '123', Name: '1 C:' }, { Node: 'PC', DiskReadBytesPersec: '0', Name: '_Total' }]);
  const ps = '"Name","Model"\r\n"0 D: E: F:","Crucial, MX500"\r\n';
  assert.deepEqual(sysm.parseCsv(ps), [{ Name: '0 D: E: F:', Model: 'Crucial, MX500' }]);
  assert.deepEqual(sysm.parseDiskInstance('0 D: E: F:'), { index: 0, letters: ['D:', 'E:', 'F:'] });
  assert.deepEqual(sysm.parseDiskInstance('5'), { index: 5, letters: [] });
  assert.equal(sysm.parseDiskInstance('_Total'), null);
  assert.equal(sysm.diskRawByIndex([{ Name: '1 C:', AvgDisksecPerTransfer: '7' }])[1].AvgDiskSecPerTransfer, 7, 'wmic 欄名 sec 小寫也要對得到');
});

test('硬碟讀寫：兩次原始計數器相減 → 讀寫速度／忙碌％／回應 ms（照微軟計數器公式）', () => {
  const F = 10000000; // 10 MHz
  const mk = (t, read, write, xfers, idle100ns, avgNum, avgBase, q) => ({
    Name: '2 H:', DiskReadBytesPersec: read, DiskWriteBytesPersec: write, DiskTransfersPersec: xfers,
    PercentIdleTime: idle100ns, Timestamp_Sys100NS: t * F, Timestamp_PerfTime: t * F, Frequency_PerfTime: F,
    CurrentDiskQueueLength: q, AvgDiskSecPerTransfer: avgNum, AvgDiskSecPerTransfer_Base: avgBase,
  });
  // 2 秒內：讀 100 MB、寫 20 MB、200 次存取、閒置 0.5 秒（忙碌 75%）、平均每次 5 ms、排隊 3
  const a = sysm.diskRawByIndex([mk(10, 0, 0, 0, 0, 0, 0, 0), { Name: '_Total', DiskReadBytesPersec: 1 }]);
  const b = sysm.diskRawByIndex([mk(12, 100 * 1048576, 20 * 1048576, 200, 0.5 * F, 0.005 * 200 * F, 200, 3)]);
  const io = sysm.diskIoFromRaw(a, b);
  assert.equal(io.length, 1);
  assert.equal(io[0].index, 2);
  assert.deepEqual(io[0].letters, ['H:']);
  assert.equal(io[0].readBps, 50 * 1048576);
  assert.equal(io[0].writeBps, 10 * 1048576);
  assert.equal(io[0].iops, 100);
  assert.equal(io[0].busyPct, 75);
  assert.equal(io[0].respMs, 5);
  assert.equal(io[0].queue, 3);
  // 沒有前一次快照、或時間沒前進 → 不給數字（不會除以零）
  assert.deepEqual(sysm.diskIoFromRaw(null, b), []);
  assert.deepEqual(sysm.diskIoFromRaw(b, b), []);
  // 閒置比時間還多（計數器抖動）→ 忙碌夾在 0
  const c = sysm.diskRawByIndex([mk(14, 100 * 1048576, 20 * 1048576, 200, 0.5 * F + 3 * F, 0.005 * 200 * F, 200, 0)]);
  assert.equal(sysm.diskIoFromRaw(b, c)[0].busyPct, 0);
});

testAsync('取樣器：touch 後 2.5 秒內取得 CPU／記憶體／硬碟，stop 後計時器停', async () => {
  const m = new sysm.SystemMetrics({ lhmUrl: 'http://127.0.0.1:1/data.json', nvidiaSmi: 'no-such-nvidia-smi' });
  m.touch();
  await new Promise((r) => setTimeout(r, 2600));
  const s = m.snapshot();
  assert.ok(s.cpu.pct !== null && s.cpu.pct >= 0 && s.cpu.pct <= 100, `cpu=${s.cpu.pct}`);
  assert.ok(s.mem.pct > 0);
  assert.ok(s.disks.length >= 1);
  assert.ok(Array.isArray(s.diskIo));
  assert.equal(s.gpu, null, '沒有 nvidia-smi → gpu null');
  assert.equal(s.gpuAvailable, false);
  assert.equal(s.lhm, null);
  m.stop();
  assert.equal(m.timer, null);
});

testAsync('伺服器：POST /api/order 回存順序；格式不對 400、太大 413、沒接 onReorder 501', async () => {
  const got = [];
  const server = new lan.LanServer({ getState: () => ({}), onReorder: (ids) => got.push(ids) });
  const { port } = await server.start(0, '127.0.0.1');
  const post = (body, p = '/api/order') =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }
      );
      req.on('error', reject);
      req.end(body);
    });
  const ok = await post(JSON.stringify({ ids: ['b', 'a', 'c'] }));
  assert.strictEqual(ok.status, 200, ok.body);
  assert.deepStrictEqual(got, [['b', 'a', 'c']]);
  assert.strictEqual((await post('{"ids":"nope"}')).status, 400);
  assert.strictEqual((await post('not json')).status, 400);
  assert.strictEqual((await post(JSON.stringify({ ids: [1, 2] }))).status, 400);
  assert.strictEqual((await post(JSON.stringify({ ids: ['x'.repeat(9000)] }))).status, 413);
  assert.strictEqual(got.length, 1, '壞請求不該呼叫 onReorder');
  await server.stop();
  const noHandler = new lan.LanServer({ getState: () => ({}) });
  const r2 = await noHandler.start(0, '127.0.0.1');
  const r = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: r2.port, path: '/api/order', method: 'POST' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end('{"ids":["a"]}');
  });
  assert.strictEqual(r, 501);
  await noHandler.stop();
});

console.log('\n硬碟讀寫取樣失敗時沿用上一筆：');
{
  const { SystemMetrics } = require('../src/sysmetrics');
  const rawAt = (t) => ({
    0: { index: 0, letters: ['C:'], Frequency_PerfTime: 10000000, Timestamp_PerfTime: t * 10000000, Timestamp_Sys100NS: t * 10000000,
      DiskReadBytesPersec: t * 1000, DiskWriteBytesPersec: 0, DiskTransfersPersec: 0, PercentIdleTime: t * 5000000,
      AvgDiskSecPerTransfer: 0, AvgDiskSecPerTransfer_Base: 0, CurrentDiskQueueLength: 0 },
  });
  testAsync('wmic 偶爾回空／回一半 → 不切回容量版面，沿用上一筆讀寫資料；30 秒後才放棄', async () => {
    const m = new SystemMetrics();
    const samples = [rawAt(0), rawAt(2), null, {}, rawAt(6)];
    m._diskRawSample = async () => samples.shift();
    m._diskModels = async () => ({ 0: { model: 'SN530', fixed: true } });
    assert.deepStrictEqual(await m._diskIo(), [], '第一筆只有基準');
    const good = await m._diskIo();
    assert.strictEqual(good.length, 1);
    assert.strictEqual(good[0].readBps, 1000);
    assert.strictEqual(await m._diskIo(), good, 'null 樣本 → 沿用');
    assert.strictEqual(await m._diskIo(), good, '空物件樣本 → 沿用，且不覆蓋基準');
    const next = await m._diskIo();
    assert.strictEqual(next.length, 1, '壞樣本之後的下一筆要能用原基準算出速度');
    assert.strictEqual(next[0].readBps, 1000);
    m.lastDiskIo.at = Date.now() - SystemMetrics.DISK_IO_STICKY_MS - 1;
    samples.push(null);
    assert.deepStrictEqual(await m._diskIo(), [], '超過 30 秒就不再沿用');
  });
}

console.log('\n憑證續期（授權失效 vs 暫時失敗）：');
{
  const { UsagePoller } = require('../src/poller');
  const { classifyTokenFailure } = require('../src/oauth');

  test('token 端點失敗分類：invalid_grant／401／403 → 授權失效；其他 4xx → 格式；5xx → 暫時', () => {
    assert.strictEqual(classifyTokenFailure(400, { error: 'invalid_grant' }), 'auth');
    assert.strictEqual(classifyTokenFailure(400, { error: { code: 'refresh_token_reused' } }), 'auth');
    assert.strictEqual(classifyTokenFailure(401, null), 'auth');
    assert.strictEqual(classifyTokenFailure(403, {}), 'auth');
    assert.strictEqual(classifyTokenFailure(400, { error: 'invalid_request' }), 'format');
    assert.strictEqual(classifyTokenFailure(429, {}), 'transient');
    assert.strictEqual(classifyTokenFailure(503, null), 'transient');
  });

  // 建一個假服務：可以控制續期成功／失敗的樣子
  function makePoller(account, { refreshImpl, fetchImpl }) {
    const events = [];
    const results = [];
    let updated = 0;
    const poller = new UsagePoller({
      getAccounts: () => [account],
      onAccountUpdated: () => { updated += 1; },
      onResult: (_id, r) => results.push(r),
      onEvent: (_id, kind, detail) => events.push({ kind, detail }),
      providers: {
        claude: {
          fetchUsage: fetchImpl || (async () => ({ buckets: [{ key: 'x', percent: 1 }], raw: {} })),
          refresh: refreshImpl,
        },
      },
    });
    return { poller, events, results, updated: () => updated };
  }
  const expired = () => ({
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    expiresAt: Date.now() - 1000,
    refreshedAt: Date.now() - 8 * 3600 * 1000,
  });

  testAsync('續期時網路不通（暫時性）→ 不標需重新授權、舊憑證保留、稍後重試', async () => {
    const account = { id: 'a1', provider: 'claude', tokens: expired(), needsReauth: false };
    const { poller, events, results } = makePoller(account, {
      refreshImpl: async () => { const e = new Error('fetch failed'); e.transient = true; throw e; },
    });
    await poller.fetchOne('a1');
    assert.strictEqual(account.needsReauth, false, '暫時失敗不該要求重新授權');
    assert.strictEqual(account.tokens.refreshToken, 'old-refresh', '舊 refresh token 要保留');
    assert.strictEqual(results[0].ok, false);
    assert.strictEqual(results[0].needsReauth, false);
    assert.ok(results[0].error.includes('暫時'), results[0].error);
    assert.ok(events.some((e) => e.kind === 'refresh_fail_transient'));
  });

  testAsync('續期被服務端拒絕（invalid_grant，確定失效）→ 才標需重新授權', async () => {
    const account = { id: 'a2', provider: 'claude', tokens: expired(), needsReauth: false };
    const { poller, events, results } = makePoller(account, {
      refreshImpl: async () => { const e = new Error('token 端點回應 400：invalid_grant'); e.definitive = true; throw e; },
    });
    await poller.fetchOne('a2');
    assert.strictEqual(account.needsReauth, true);
    assert.strictEqual(results[0].needsReauth, true);
    assert.ok(events.some((e) => e.kind === 'reauth_needed'));
  });

  testAsync('保鮮：access token 還有效但 6 天沒續期 → 主動續期並記下新時間', async () => {
    const account = {
      id: 'a3', provider: 'claude', needsReauth: false,
      tokens: { accessToken: 'still-good', refreshToken: 'r1', expiresAt: Date.now() + 3 * 24 * 3600 * 1000, refreshedAt: Date.now() - 7 * 24 * 3600 * 1000 },
    };
    let refreshed = 0;
    const seenTokens = [];
    const { poller, events, results } = makePoller(account, {
      refreshImpl: async () => { refreshed += 1; return { accessToken: 'new-access', refreshToken: 'r2', expiresAt: Date.now() + 10 * 24 * 3600 * 1000, refreshedAt: Date.now() }; },
      fetchImpl: async (_a, tok) => { seenTokens.push(tok); return { buckets: [], raw: {} }; },
    });
    await poller.fetchOne('a3');
    assert.strictEqual(refreshed, 1, '應該主動續期一次');
    assert.deepStrictEqual(seenTokens, ['new-access']);
    assert.strictEqual(account.tokens.refreshToken, 'r2');
    assert.ok(Date.now() - account.tokens.refreshedAt < 5000);
    assert.strictEqual(results[0].ok, true);
    assert.ok(events.some((e) => e.kind === 'refresh_ok_keepalive'));
    // 第二次抓：剛續過，不該再續
    await poller.fetchOne('a3');
    assert.strictEqual(refreshed, 1);
  });

  testAsync('保鮮續期暫時失敗 → 繼續用還有效的舊 token，用量照常抓到；一小時內不重試保鮮', async () => {
    const account = {
      id: 'a4', provider: 'claude', needsReauth: false,
      tokens: { accessToken: 'still-good', refreshToken: 'r1', expiresAt: Date.now() + 3 * 24 * 3600 * 1000, refreshedAt: Date.now() - 7 * 24 * 3600 * 1000 },
    };
    let refreshed = 0;
    const { poller, events, results } = makePoller(account, {
      refreshImpl: async () => { refreshed += 1; const e = new Error('503'); e.transient = true; throw e; },
    });
    await poller.fetchOne('a4');
    await poller.fetchOne('a4');
    assert.strictEqual(refreshed, 1, '保鮮失敗後一小時內不該再試');
    assert.strictEqual(results.length, 2);
    assert.ok(results.every((r) => r.ok), '舊 token 還有效，用量應照常抓到');
    assert.strictEqual(account.needsReauth, false);
    assert.ok(events.some((e) => e.kind === 'keepalive_fail_transient'));
  });

  testAsync('舊版帳號資料沒有 refreshedAt → 第一次會補續一次，之後正常', async () => {
    const account = {
      id: 'a5', provider: 'claude', needsReauth: false,
      tokens: { accessToken: 'ok', refreshToken: 'r1', expiresAt: Date.now() + 3600 * 1000 },
    };
    let refreshed = 0;
    const { poller } = makePoller(account, {
      refreshImpl: async () => { refreshed += 1; return { accessToken: 'n', refreshToken: 'r2', expiresAt: Date.now() + 3600 * 1000, refreshedAt: Date.now() }; },
    });
    await poller.fetchOne('a5');
    await poller.fetchOne('a5');
    assert.strictEqual(refreshed, 1);
  });

  testAsync('抓用量卡住不回 → 硬逾時當暫時失敗；inFlight 卡太久 → 看門狗解鎖，下一輪照常抓', async () => {
    const origHard = C.FETCH_HARD_TIMEOUT_MS;
    const origStuck = C.FETCH_STUCK_MS;
    C.FETCH_HARD_TIMEOUT_MS = 150;
    C.FETCH_STUCK_MS = 100;
    try {
      const account = {
        id: 'a6', provider: 'claude', needsReauth: false,
        tokens: { accessToken: 'ok', refreshToken: 'r', expiresAt: Date.now() + 3600 * 1000, refreshedAt: Date.now() },
      };
      let calls = 0;
      const { poller, events, results } = makePoller(account, {
        refreshImpl: async () => { throw new Error('不該續期'); },
        fetchImpl: () => { calls += 1; return calls === 1 ? new Promise(() => {}) : Promise.resolve({ buckets: [], raw: {} }); },
      });
      await poller.fetchOne('a6');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].ok, false);
      assert.ok(results[0].error.includes('沒回應'), results[0].error);
      assert.strictEqual(account.needsReauth, false);
      assert.strictEqual(poller._stateOf('a6').inFlight, false, '硬逾時後要解鎖');
      const st = poller._stateOf('a6');
      st.inFlight = true; st.startedAt = Date.now() - 1000; st.nextAt = 0;
      poller.tick();
      assert.ok(events.some((e) => e.kind === 'fetch_stuck'), '看門狗要記一筆');
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(calls, 2, '解鎖後同一輪就重新抓');
      assert.strictEqual(results[results.length - 1].ok, true);
    } finally {
      C.FETCH_HARD_TIMEOUT_MS = origHard;
      C.FETCH_STUCK_MS = origStuck;
    }
  });

  test('事件紀錄：寫入 events.log，超過上限會只留後半', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aium-ev-'));
    const store = new Store(dir);
    store.appendEvent('[refresh_ok] claude/測試');
    const text = fs.readFileSync(path.join(dir, 'events.log'), 'utf8');
    assert.ok(/^\d{4}-\d{2}-\d{2}T.* \[refresh_ok\] claude\/測試\n$/.test(text), text);
    fs.writeFileSync(path.join(dir, 'events.log'), 'x'.repeat(600 * 1024) + '\n');
    store.appendEvent('tail');
    const after = fs.readFileSync(path.join(dir, 'events.log'), 'utf8');
    assert.ok(after.length < 400 * 1024, `應被截短，現在 ${after.length}`);
    assert.ok(after.endsWith('tail\n'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

Promise.all(pending).then(() => {
  console.log(`\n${passed} 項測試${process.exitCode ? '（有失敗）' : '全部通過'}`);
});


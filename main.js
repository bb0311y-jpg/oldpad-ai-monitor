'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  ipcMain,
  shell,
  clipboard,
  nativeImage,
  powerMonitor,
  screen,
  Notification,
  net,
} = require('electron');

const C = require('./src/constants');
const oauth = require('./src/oauth');
const oauthOpenai = require('./src/oauth-openai');
const claudeProvider = require('./src/providers/claude');
const { Store } = require('./src/store');
const { UsagePoller } = require('./src/poller');
const { gaugePng } = require('./src/icon');
const { LanServer, DEFAULT_PORT: LAN_DEFAULT_PORT } = require('./src/lan-server');
const { SystemMetrics } = require('./src/sysmetrics');

// 打包版的產品名稱是中文，但資料要沿用開發期的 %APPDATA%\ai-usage-monitor，
// 這樣帳號授權不會因為改用安裝版而不見。
if (app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'ai-usage-monitor'));
}

// ---- 啟動參數 ----------------------------------------------
const IS_SMOKE = process.argv.includes('--smoke');
const OUT_ARG = process.argv.find((a) => a.startsWith('--out='));
const SMOKE_OUT = OUT_ARG ? OUT_ARG.slice('--out='.length) : path.join(process.cwd(), 'smoke.png');

const DEFAULT_SETTINGS = {
  alwaysOnTop: true,
  opacity: 1,
  refreshMinutes: C.DEFAULT_REFRESH_MINUTES,
  compact: false,
  columns: 2, // 0 = 依視窗寬度自動；1 = 單欄直列；2 = 雙欄（左 1 右 2、左 3 右 4…）；3 = 三欄
  autoHeight: true, // 視窗高度自動貼合內容；使用者手動拉過高度就會變 false
  transparent: true,
  openAtLogin: false,
  bounds: null, // { x, y, w, h }：位置與使用者拉出來的大小
  firstTrayHint: true,
  lanEnabled: true, // 在區網開一個網頁儀表板，給 iPad／手機看（v1.3.0）
  lanPort: LAN_DEFAULT_PORT,
  autoUpdate: true, // 自動到 GitHub Releases 檢查新版、背景下載，重啟時安裝（只換程式本體，不動帳號資料）
};

// ============================================================
// 自動更新（electron-updater → GitHub Releases）
//  - 只在打包後的安裝版運作；開發模式與 smoke 不做
//  - 流程：啟動 30 秒後檢查 → 有新版就背景下載 → 下載完提示「重新啟動更新」；
//    使用者不理它也沒關係，下次關閉程式時會自動裝好
//  - 更新只會覆蓋程式本體，帳號授權與設定都在 %APPDATA%，不受影響
// ============================================================

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch {
  /* 沒裝 electron-updater（例如從原始碼跑）就當沒有這個功能 */
}
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
let updateState = { status: 'idle', version: null, percent: null, error: null, checkedAt: null };
let updateTimer = null;

function setUpdateState(patch) {
  updateState = { ...updateState, ...patch };
  broadcast('update:state', updateState);
  updateTray();
}

function updateAvailable() {
  return Boolean(autoUpdater) && app.isPackaged && !IS_SMOKE;
}

function checkForUpdates(manual = false) {
  if (!updateAvailable()) return updateState;
  if (!manual && !settings.autoUpdate) return updateState;
  if (updateState.status === 'downloading' || updateState.status === 'ready') return updateState;
  setUpdateState({ status: 'checking', error: null, checkedAt: Date.now() });
  autoUpdater.checkForUpdates().catch((err) => {
    setUpdateState({ status: 'error', error: err.message });
    store.appendEvent(`[update_error] ${err.message}`);
  });
  return updateState;
}

function setupAutoUpdate() {
  if (!updateAvailable()) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;
  autoUpdater.on('update-available', (info) => {
    setUpdateState({ status: 'downloading', version: info.version, percent: 0 });
    store.appendEvent(`[update_available] v${info.version}`);
  });
  autoUpdater.on('update-not-available', () => setUpdateState({ status: 'idle', version: null, percent: null }));
  autoUpdater.on('download-progress', (p) => setUpdateState({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({ status: 'ready', version: info.version, percent: 100 });
    store.appendEvent(`[update_ready] v${info.version} 已下載，重新啟動即安裝`);
  });
  autoUpdater.on('error', (err) => {
    // 網路不通、GitHub 暫時掛掉之類：記一筆就好，不打擾使用者
    setUpdateState({ status: 'error', error: err && err.message ? err.message : String(err) });
    store.appendEvent(`[update_error] ${err && err.message ? err.message : err}`);
  });
  setTimeout(() => checkForUpdates(false), 30 * 1000);
  updateTimer = setInterval(() => checkForUpdates(false), UPDATE_CHECK_EVERY_MS);
}

function installUpdateNow() {
  if (!updateAvailable() || updateState.status !== 'ready') return false;
  quitting = true;
  store.appendEvent(`[update_install] v${updateState.version}`);
  setImmediate(() => autoUpdater.quitAndInstall(false, true));
  return true;
}

// 切換欄數／精簡模式時套用的預設視窗寬度（欄數 × 卡片寬 + 邊距）；
// 之後使用者可以再自己拉大縮小
// （每欄 348 / 精簡 272，加欄距 8 與邊距 24，對齊 renderer/layout.js 的設計寬，這樣預設寬度下 zoom 剛好 = 1）
const WIDTHS = {
  1: { normal: 372, compact: 296 },
  2: { normal: 728, compact: 576 },
  3: { normal: 1092, compact: 856 },
};
const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 460;

let store;
let settings;
let accounts = [];
let usageCache = {};
let win = null;
let tray = null;
let poller = null;
let lanServer = null;
let sysMetrics = null;
let quitting = false;
const authSessions = new Map(); // authId -> { verifier, state, accountId|null }

// ============================================================
// 帳號資料工具
// ============================================================

function sanitizeAccount(a) {
  // 傳給畫面的資料絕不包含 token
  return {
    id: a.id,
    provider: a.provider,
    label: a.label,
    email: a.email || null,
    needsReauth: Boolean(a.needsReauth),
    collapsed: Boolean(a.collapsed),
    planType: a.planType || null,
    createdAt: a.createdAt,
  };
}

function persistAccounts() {
  store.saveAccounts(accounts);
}

// 等到系統回報「有網路」為止（每 3 秒看一次），超過 maxMs 就放棄等待直接往下走
function waitForOnline(maxMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + maxMs;
    const check = () => {
      let online = true;
      try { online = net.isOnline(); } catch { /* 舊版 Electron 沒有這個 API 就當作有網路 */ }
      if (online || Date.now() >= deadline) return resolve();
      setTimeout(check, 3000);
    };
    setTimeout(check, 5000);
  });
}

function broadcast(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function pushAccounts() {
  broadcast('accounts:changed', accounts.map(sanitizeAccount));
  updateTray();
}

// ============================================================
// 視窗
// ============================================================

// 依欄數設定查表的預設寬度（自動欄數時用雙欄的寬）
function defaultWidth() {
  const cols = WIDTHS[settings.columns] ? settings.columns : 2;
  return settings.compact ? WIDTHS[cols].compact : WIDTHS[cols].normal;
}

// 使用者記住的視窗大小（沒有就用預設）
function savedSize() {
  const b = settings.bounds || {};
  const w = Number.isFinite(b.w) ? Math.max(MIN_WIDTH, Math.round(b.w)) : defaultWidth();
  const h = Number.isFinite(b.h) ? Math.max(MIN_HEIGHT, Math.round(b.h)) : DEFAULT_HEIGHT;
  return { w, h };
}

function saveBounds() {
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const [w, h] = win.getContentSize();
  settings.bounds = { x, y, w, h };
  store.saveSettings(settings);
}

// 使用者正在用滑鼠拉視窗邊緣時，畫面送來的「自動高度」先記著，拉完再套
let userResizing = false;
let pendingHeight = null;

function setContentHeight(height) {
  if (!win || win.isDestroyed()) return;
  const wa = screen.getDisplayMatching(win.getBounds()).workArea;
  const h = Math.round(Math.min(Math.max(height, MIN_HEIGHT), wa.height * 0.92));
  const [w, curH] = win.getContentSize();
  if (h === curH) return;
  win.setContentSize(w, h);
}

function createWindow() {
  const iconImage = nativeImage.createFromBuffer(gaugePng(64));
  const size = savedSize();
  win = new BrowserWindow({
    width: size.w,
    height: size.h,
    useContentSize: true,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    frame: false,
    transparent: Boolean(settings.transparent),
    backgroundColor: settings.transparent ? undefined : '#11131a',
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: IS_SMOKE,
    show: false,
    alwaysOnTop: Boolean(settings.alwaysOnTop),
    icon: iconImage,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: IS_SMOKE,
    },
  });

  if (settings.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 還原上次視窗位置（要確認還在任一螢幕範圍內）
  if (settings.bounds && Number.isFinite(settings.bounds.x)) {
    const { x, y } = settings.bounds;
    const visible = screen.getAllDisplays().some((d) => {
      const wa = d.workArea;
      return x >= wa.x - 50 && x < wa.x + wa.width - 60 && y >= wa.y - 20 && y < wa.y + wa.height - 60;
    });
    if (visible) win.setPosition(Math.round(x), Math.round(y));
  }

  win.once('ready-to-show', () => {
    if (!IS_SMOKE) {
      win.show();
      if (settings.opacity < 1) win.setOpacity(settings.opacity);
    }
  });

  let moveTimer = null;
  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(saveBounds, 500);
  });

  // 使用者用滑鼠拉視窗邊緣（程式自己 setContentSize 不會觸發 will-resize）
  win.on('will-resize', (_e, newBounds) => {
    userResizing = true;
    const [, curH] = win.getContentSize();
    // 高度被使用者改了 → 關掉自動高度，之後尊重他拉的高度
    if (settings.autoHeight && Math.abs(newBounds.height - curH) > 2) {
      settings.autoHeight = false;
      broadcast('settings:changed', settings);
    }
  });
  win.on('resized', () => {
    userResizing = false;
    saveBounds();
    if (pendingHeight != null && settings.autoHeight) {
      setContentHeight(pendingHeight);
      pendingHeight = null;
    }
  });

  // 半透明時：滑鼠移上來變清楚，移開恢復
  win.on('close', (e) => {
    if (!quitting && !IS_SMOKE) {
      e.preventDefault();
      hideToTray();
    }
  });
}

function recreateWindow() {
  const old = win;
  win = null;
  if (old && !old.isDestroyed()) old.destroy();
  createWindow();
}

function hideToTray() {
  if (!win) return;
  win.hide();
  if (settings.firstTrayHint) {
    settings.firstTrayHint = false;
    store.saveSettings(settings);
    if (Notification.isSupported()) {
      new Notification({
        title: 'AI 用量監控還在執行',
        body: '已縮到右下角系統列，點圖示可再打開；要完全關閉請在圖示上按右鍵選「結束」。',
      }).show();
    }
  }
}

// moveToCursor = true 時，把視窗移到滑鼠所在的螢幕中央偏上
// （解決「視窗停在另一顆螢幕/看不到的位置」找不到程式的問題）
function showWindow(moveToCursor = false) {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (moveToCursor) {
    const cursor = screen.getCursorScreenPoint();
    const wa = screen.getDisplayNearestPoint(cursor).workArea;
    const [w, h] = win.getSize();
    const x = Math.round(wa.x + (wa.width - w) / 2);
    const y = Math.round(wa.y + Math.max(20, (wa.height - h) / 3));
    win.setPosition(x, y);
    saveBounds();
  }
  win.show();
  win.focus();
}

// ============================================================
// 區網儀表板（iPad／手機用瀏覽器看）
// ============================================================

// 給儀表板的完整狀態：帳號一律 sanitize（不含 token），系統指標即時取樣
function lanState() {
  return {
    version: app.getVersion(),
    now: Date.now(),
    accounts: accounts.map(sanitizeAccount),
    order: Array.isArray(settings.dashboardOrder) ? settings.dashboardOrder : [], // 儀表板自己的卡片順序（拖曳排序）
    usage: usageCache,
    system: sysMetrics ? sysMetrics.snapshot() : null,
  };
}

async function startLanServer() {
  if (!sysMetrics) sysMetrics = new SystemMetrics();
  if (!lanServer) {
    lanServer = new LanServer({
      getState: lanState,
      log: (m) => console.log(m),
      // iPad 上拖曳排序 → 只記儀表板的順序（不動桌面小窗的順序），存在 settings.json
      onReorder: (ids) => {
        const known = new Set(accounts.map((a) => a.id));
        settings.dashboardOrder = ids.filter((id) => known.has(id));
        store.saveSettings(settings);
      },
    });
  }
  if (settings.lanEnabled) {
    try {
      await lanServer.start(Number(settings.lanPort) || LAN_DEFAULT_PORT);
    } catch (err) {
      console.error('區網儀表板啟動失敗：', err.message);
    }
  }
  broadcast('lan:changed', lanInfo());
  updateTray();
}

// 開關／換埠的動作排成一條鏈，同一時間只跑一個，快速連點也不會交錯
let lanOp = Promise.resolve();
function restartLanServer() {
  lanOp = lanOp
    .then(async () => {
      if (lanServer) await lanServer.stop();
      if (sysMetrics) sysMetrics.stop();
      await startLanServer();
    })
    .catch((err) => console.error('區網儀表板重啟失敗：', err.message));
  return lanOp;
}

function lanInfo() {
  const info = lanServer ? lanServer.info() : { running: false, port: null, error: null, urls: [] };
  return { ...info, enabled: Boolean(settings.lanEnabled), configuredPort: Number(settings.lanPort) || LAN_DEFAULT_PORT };
}

// ============================================================
// 系統列（tray）
// ============================================================

function trayTooltip() {
  const lines = ['AI 用量監控'];
  for (const a of accounts) {
    const u = usageCache[a.id];
    if (u && u.ok) {
      const session = u.buckets.find((b) => b.kind === 'session');
      const week = u.buckets.find((b) => b.kind === 'weekly_all');
      const fmt = (b) => (b ? `${Math.round(b.percent)}%` : '–');
      lines.push(`${a.label}：5h ${fmt(session)}｜週 ${fmt(week)}`);
    } else {
      lines.push(`${a.label}：（尚無資料）`);
    }
  }
  return lines.join('\n').slice(0, 127);
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(trayTooltip());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '顯示 / 隱藏', click: () => (win && win.isVisible() ? win.hide() : showWindow()) },
      { label: '把視窗移到目前螢幕', click: () => showWindow(true) },
      { label: '立即更新用量', click: () => poller && poller.refreshAll(true) },
      { type: 'separator' },
      ...lanTrayItems(),
      ...updateTrayItems(),
      {
        label: '視窗置頂',
        type: 'checkbox',
        checked: Boolean(settings.alwaysOnTop),
        click: (item) => applySettings({ alwaysOnTop: item.checked }),
      },
      {
        label: '開機自動啟動',
        type: 'checkbox',
        checked: Boolean(settings.openAtLogin),
        click: (item) => applySettings({ openAtLogin: item.checked }),
      },
      { type: 'separator' },
      {
        label: '結束',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

// 系統列選單裡的「更新」：下載好了就變成一鍵重啟安裝
function updateTrayItems() {
  if (!updateAvailable()) return [];
  if (updateState.status === 'ready') {
    return [{ label: `重新啟動以更新到 v${updateState.version}`, click: () => installUpdateNow() }];
  }
  if (updateState.status === 'downloading') {
    return [{ label: `正在下載 v${updateState.version}（${updateState.percent || 0}%）`, enabled: false }];
  }
  return [{ label: '檢查更新', click: () => checkForUpdates(true) }];
}

// 系統列選單裡的「iPad 儀表板網址」：點一下複製
function lanTrayItems() {
  const info = lanInfo();
  if (!info.enabled) return [{ label: 'iPad 儀表板：已關閉（設定裡可開）', enabled: false }];
  if (!info.running) return [{ label: `iPad 儀表板：${info.error || '啟動中…'}`, enabled: false }];
  const items = info.urls.slice(0, 3).map((url) => ({
    label: `iPad 儀表板：${url}（點一下複製）`,
    click: () => clipboard.writeText(url),
  }));
  return items.length ? items : [{ label: 'iPad 儀表板：找不到區網 IP', enabled: false }];
}

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(gaugePng(32)));
  tray.on('click', () => (win && win.isVisible() ? win.hide() : showWindow()));
  updateTray();
}

// ============================================================
// 設定
// ============================================================

function applySettings(patch) {
  const prev = settings;
  settings = { ...settings, ...patch };
  store.saveSettings(settings);

  if (win && !win.isDestroyed()) {
    if ('alwaysOnTop' in patch) win.setAlwaysOnTop(Boolean(patch.alwaysOnTop), 'screen-saver');
    if ('opacity' in patch) win.setOpacity(Math.min(1, Math.max(0.4, Number(patch.opacity) || 1)));
    // 換欄數／切精簡：套該欄數的預設寬度（自動欄數時不動寬度，讓畫面自己排）
    if (('compact' in patch || 'columns' in patch) && WIDTHS[settings.columns]) {
      const [, h] = win.getContentSize();
      win.setContentSize(defaultWidth(), h);
      saveBounds();
    }
  }
  if ('refreshMinutes' in patch && poller) poller.setIntervalMinutes(patch.refreshMinutes);
  if ('openAtLogin' in patch) {
    try {
      app.setLoginItemSettings({
        openAtLogin: Boolean(patch.openAtLogin),
        path: process.execPath,
        args: app.isPackaged ? [] : [app.getAppPath()],
      });
    } catch (err) {
      console.error('設定開機啟動失敗：', err.message);
    }
  }
  if ('transparent' in patch && patch.transparent !== prev.transparent) {
    recreateWindow(); // 透明效果要重建視窗才會生效
  }
  if (('lanEnabled' in patch || 'lanPort' in patch) && !IS_SMOKE) {
    restartLanServer(); // 開關或換埠號 → 重開區網服務（非同步，完成後會廣播 lan:changed）
  }
  broadcast('settings:changed', settings);
  updateTray();
}

// ============================================================
// IPC：畫面 ⇄ 主程序
// ============================================================

function registerIpc() {
  ipcMain.handle('state:get', () => ({
    accounts: accounts.map(sanitizeAccount),
    settings,
    usage: usageCache,
    version: app.getVersion(),
    lan: lanInfo(),
    update: { ...updateState, supported: updateAvailable() },
  }));

  ipcMain.handle('update:check', () => ({ ...checkForUpdates(true), supported: updateAvailable() }));
  ipcMain.handle('update:install', () => installUpdateNow());

  ipcMain.handle('lan:info', () => lanInfo());
  ipcMain.handle('lan:copyUrl', () => {
    const info = lanInfo();
    if (info.urls[0]) clipboard.writeText(info.urls[0]);
    return Boolean(info.urls[0]);
  });

  // ---- OAuth 授權 ----

  // 授權成功後建立或更新帳號（Claude 與 Codex 共用）
  function upsertAuthedAccount({ reauthId, provider, tokens, email, extra }) {
    let account;
    if (reauthId) {
      account = accounts.find((a) => a.id === reauthId);
      if (!account) return { ok: false, error: '找不到要重新授權的帳號' };
      account.tokens = tokens;
      account.needsReauth = false;
      if (email) account.email = email;
      Object.assign(account, extra || {});
    } else {
      const duplicate = email && accounts.find((a) => a.provider === provider && a.email === email);
      if (duplicate) {
        // 同一個帳號再授權一次 → 更新 token，不新增卡片
        duplicate.tokens = tokens;
        duplicate.needsReauth = false;
        Object.assign(duplicate, extra || {});
        account = duplicate;
      } else {
        const sameProviderCount = accounts.filter((a) => a.provider === provider).length;
        account = {
          id: crypto.randomUUID(),
          provider,
          label: email || `${provider === 'codex' ? 'Codex' : 'Claude'} 帳號 ${sameProviderCount + 1}`,
          email: email || null,
          createdAt: Date.now(),
          needsReauth: false,
          tokens,
          ...(extra || {}),
        };
        accounts.push(account);
      }
    }
    persistAccounts();
    pushAccounts();
    poller.fetchOne(account.id, true);
    return { ok: true, account: sanitizeAccount(account) };
  }

  ipcMain.handle('auth:begin', (_e, { accountId = null, provider = null } = {}) => {
    const target = accountId ? accounts.find((a) => a.id === accountId) : null;
    const prov = provider || (target && target.provider) || 'claude';
    const authId = crypto.randomUUID();

    if (prov === 'codex') {
      // Codex：本機 1455 埠自動接收授權碼，全程不用貼碼
      const mod = oauthOpenai;
      const { url, verifier, state } = mod.buildAuthorization();
      const srv = mod.startCallbackServer(state);
      authSessions.set(authId, { provider: prov, verifier, state, accountId, url, closeServer: srv.close });
      shell.openExternal(url);
      srv.promise
        .then(async ({ code }) => {
          const { tokens, identity } = await mod.exchangeCode({ code, verifier });
          const result = upsertAuthedAccount({
            reauthId: accountId,
            provider: prov,
            tokens,
            email: identity.email,
            extra: { accountId: identity.accountId, planType: identity.planType },
          });
          authSessions.delete(authId);
          broadcast('auth:auto', { authId, ...result });
        })
        .catch((err) => {
          authSessions.delete(authId);
          broadcast('auth:auto', { authId, ok: false, error: err.message });
        });
      return { authId, url, mode: 'auto', provider: prov };
    }

    // Claude：回跳頁顯示授權碼，使用者貼回來
    const { url, verifier, state } = oauth.buildAuthorization();
    authSessions.set(authId, { provider: 'claude', verifier, state, accountId, url });
    shell.openExternal(url);
    return { authId, url, mode: 'paste' };
  });

  ipcMain.handle('auth:copyUrl', (_e, { authId }) => {
    const s = authSessions.get(authId);
    if (s) clipboard.writeText(s.url);
    return Boolean(s);
  });

  ipcMain.handle('auth:cancel', (_e, { authId }) => {
    const s = authSessions.get(authId);
    if (s && s.closeServer) s.closeServer();
    authSessions.delete(authId);
    return true;
  });

  ipcMain.handle('auth:complete', async (_e, { authId, pastedCode }) => {
    const sess = authSessions.get(authId);
    if (!sess) return { ok: false, error: '授權流程已逾時或被取消，請重新開始' };
    try {
      const tokens = await oauth.exchangeCode({
        pastedCode,
        verifier: sess.verifier,
        state: sess.state,
      });

      // 盡量抓 email 來標示帳號（失敗不擋流程）
      let email = null;
      try {
        const profile = await claudeProvider.fetchProfile(tokens.accessToken);
        email = profile.email;
      } catch {
        /* 拿不到就讓使用者自己命名 */
      }

      const result = upsertAuthedAccount({ reauthId: sess.accountId, provider: 'claude', tokens, email });
      if (result.ok) authSessions.delete(authId);
      return result;
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // ---- 帳號管理 ----
  ipcMain.handle('account:rename', (_e, { id, label }) => {
    const a = accounts.find((x) => x.id === id);
    if (a && String(label || '').trim()) {
      a.label = String(label).trim().slice(0, 40);
      persistAccounts();
      pushAccounts();
    }
    return true;
  });

  // 依畫面拖曳後的 id 順序重排帳號（順序會存起來）
  ipcMain.handle('account:reorder', (_e, { ids }) => {
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const next = [];
    for (const id of ids || []) {
      if (byId.has(id)) {
        next.push(byId.get(id));
        byId.delete(id);
      }
    }
    next.push(...byId.values()); // 保險：沒列到的排最後
    accounts = next;
    persistAccounts();
    pushAccounts();
    return true;
  });

  ipcMain.handle('account:setCollapsed', (_e, { id, collapsed }) => {
    const a = accounts.find((x) => x.id === id);
    if (a) {
      a.collapsed = Boolean(collapsed);
      persistAccounts();
      pushAccounts();
    }
    return true;
  });

  ipcMain.handle('account:remove', (_e, { id }) => {
    accounts = accounts.filter((x) => x.id !== id);
    delete usageCache[id];
    persistAccounts();
    store.saveCache(usageCache);
    pushAccounts();
    return true;
  });

  ipcMain.handle('demo:add', () => {
    const n = accounts.filter((a) => a.provider === 'demo').length + 1;
    accounts.push({
      id: crypto.randomUUID(),
      provider: 'demo',
      label: `示範帳號 ${n}`,
      email: `demo${n}@example.com`,
      createdAt: Date.now(),
      needsReauth: false,
      demoSeed: n * 1.7,
    });
    persistAccounts();
    pushAccounts();
    poller.refreshAll(true);
    return true;
  });

  // ---- 用量 ----
  ipcMain.handle('usage:refresh', (_e, { accountId } = {}) => {
    if (accountId) poller.fetchOne(accountId, true);
    else poller.refreshAll(true);
    return true;
  });

  // ---- 設定與視窗 ----
  ipcMain.handle('settings:update', (_e, patch) => {
    applySettings(patch || {});
    return settings;
  });

  // 畫面算好「自動高度」後送來；只動高度，寬度維持使用者拉的
  ipcMain.handle('window:setHeight', (_e, height) => {
    if (!win || win.isDestroyed() || !settings.autoHeight) return false;
    if (userResizing) {
      pendingHeight = height; // 拉邊緣中不要跟滑鼠搶，拉完再套
      return true;
    }
    setContentHeight(height);
    saveBounds();
    return true;
  });

  // 右下角拉柄：畫面回報滑鼠從按下到現在移了多少，主程序照著改大小
  let dragStart = null;
  ipcMain.handle('window:resizeDrag', (_e, { phase, dx = 0, dy = 0 } = {}) => {
    if (!win || win.isDestroyed()) return false;
    if (phase === 'start') {
      const [w, h] = win.getContentSize();
      dragStart = { w, h };
      userResizing = true;
      return true;
    }
    if (!dragStart) return false;
    const wa = screen.getDisplayMatching(win.getBounds()).workArea;
    const w = Math.round(Math.min(Math.max(dragStart.w + dx, MIN_WIDTH), wa.width));
    const h = Math.round(Math.min(Math.max(dragStart.h + dy, MIN_HEIGHT), wa.height));
    win.setContentSize(w, h);
    if (phase === 'end') {
      const heightChanged = Math.abs(h - dragStart.h) > 2;
      dragStart = null;
      userResizing = false;
      if (heightChanged && settings.autoHeight) settings.autoHeight = false;
      saveBounds();
      broadcast('settings:changed', settings);
    }
    return true;
  });

  ipcMain.handle('window:hide', () => hideToTray());
  ipcMain.handle('window:quit', () => {
    quitting = true;
    app.quit();
  });
  ipcMain.handle('open:external', (_e, url) => {
    if (/^https:\/\//.test(String(url))) shell.openExternal(url);
  });
}

// ============================================================
// 煙霧測試模式（--smoke）：離屏渲染 → 截圖存檔 → 自動結束
// ============================================================

async function runSmoke() {
  const timeout = setTimeout(() => {
    console.error('SMOKE_FAIL: 逾時');
    app.exit(2);
  }, 25000);

  try {
    // 加三個示範帳號模擬真實使用情境
    for (let i = 1; i <= 3; i++) {
      accounts.push({
        id: `demo-${i}`,
        provider: 'demo',
        label: `帳號${['一', '二', '三'][i - 1]}`,
        email: `demo${i}@example.com`,
        createdAt: Date.now(),
        needsReauth: i === 3, // 讓第三個帳號呈現「需要重新授權」狀態，順便驗 UI
        collapsed: i === 2, // 第二個帳號呈現收合狀態，驗證一行摘要 UI
        demoSeed: i * 1.7,
      });
    }
    // 第四張卡：Codex 徽章＋需要授權狀態（不打網路）
    accounts.push({
      id: 'demo-codex',
      provider: 'codex',
      label: 'Codex 帳號 1',
      email: 'demo-codex@example.com',
      createdAt: Date.now(),
      needsReauth: true,
      planType: 'plus',
    });
    await new Promise((resolve) => {
      win.webContents.once('did-finish-load', resolve);
    });
    pushAccounts();
    poller.refreshAll(true);
    await new Promise((r) => setTimeout(r, 2500)); // 等資料進畫面、動畫跑完
    const image = await win.webContents.capturePage();
    fs.writeFileSync(SMOKE_OUT, image.toPNG());

    // 區網儀表板自檢：隨機埠啟動 → 自己打 /api/state → 確認帳號資料沒夾帶 token
    sysMetrics = new SystemMetrics();
    lanServer = new LanServer({ getState: lanState });
    await lanServer.start(0, '127.0.0.1');
    const lanJson = await new Promise((resolve, reject) => {
      require('http').get(`http://127.0.0.1:${lanServer.port}/api/state`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }).on('error', reject);
    });
    const lanData = JSON.parse(lanJson);
    if (/accessToken|refreshToken/.test(lanJson)) throw new Error('區網 API 竟然夾帶 token');
    if (lanData.accounts.length !== accounts.length) throw new Error('區網 API 帳號數不符');
    console.log(`SMOKE_LAN 埠 ${lanServer.port} 帳號 ${lanData.accounts.length} CPU ${lanData.system.cpu.count} 核 GPU ${lanData.system.gpu ? lanData.system.gpu.name : "無"} 硬碟讀寫 ${(lanData.system.diskIo || []).length} 顆`);
    await lanServer.stop();
    sysMetrics.stop();
    const [w, h] = win.getContentSize();
    const layout = await win.webContents.executeJavaScript('JSON.stringify(window.__layoutDebug || null)');
    console.log(`SMOKE_LAYOUT 視窗 ${w}x${h} ${layout}`);
    console.log(`SMOKE_OK 截圖已存到 ${SMOKE_OUT}`);
    clearTimeout(timeout);
    app.exit(0);
  } catch (err) {
    console.error('SMOKE_FAIL:', err);
    clearTimeout(timeout);
    app.exit(1);
  }
}

// ============================================================
// 啟動
// ============================================================

const gotLock = IS_SMOKE || app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // 使用者又點了一次啟動器 → 不開第二份，把既有視窗移到他眼前
  app.on('second-instance', () => {
    showWindow(true);
    if (Notification.isSupported()) {
      new Notification({
        title: 'AI 用量監控已經在執行了',
        body: '已把視窗移到你目前的螢幕。找不到圖示的話，看看系統列的「^」摺疊區。',
      }).show();
    }
  });

  app.whenReady().then(() => {
    store = new Store(app.getPath('userData'), { ephemeral: IS_SMOKE });
    settings = store.loadSettings(DEFAULT_SETTINGS);
    if (IS_SMOKE) {
      // 煙霧測試可指定尺寸來驗證縮放：--compact --cols=0|1|2|3 --width=… --height=…（給了高度就是手動高度模式）
      const arg = (name) => {
        const a = process.argv.find((x) => x.startsWith(`--${name}=`));
        return a ? Number(a.slice(name.length + 3)) : null;
      };
      if (process.argv.includes('--compact')) settings.compact = true;
      if (arg('cols') != null) settings.columns = arg('cols');
      const w = arg('width');
      const h = arg('height');
      if (w || h) {
        settings.bounds = { w: w || defaultWidth(), h: h || DEFAULT_HEIGHT };
        if (h) settings.autoHeight = false;
      }
    }
    accounts = IS_SMOKE ? [] : store.loadAccounts();
    usageCache = IS_SMOKE ? {} : store.loadCache();

    poller = new UsagePoller({
      getAccounts: () => accounts,
      onAccountUpdated: () => {
        persistAccounts();
        pushAccounts();
      },
      onResult: (accountId, result) => {
        usageCache[accountId] = result;
        store.saveCache(usageCache);
        broadcast('usage:update', { accountId, result });
        updateTray();
      },
      onRaw: (accountId, raw) => store.saveDebugRaw(accountId, raw),
      onEvent: (accountId, kind, detail) => {
        const acc = accounts.find((a) => a.id === accountId);
        const who = acc ? `${acc.provider}/${acc.label}` : accountId;
        store.appendEvent(`[${kind}] ${who}${detail ? ` ${detail}` : ''}`);
      },
    });
    poller.setIntervalMinutes(settings.refreshMinutes);

    registerIpc();
    createWindow();
    if (!IS_SMOKE) {
      createTray();
      poller.start();
      startLanServer();
      setupAutoUpdate();
      // 剛從睡眠醒來時網路常常還沒接上：先等網路恢復（最多 90 秒）再抓，
      // 避免把「一時連不上」誤判成授權失效
      powerMonitor.on('resume', () => {
        store.appendEvent('[resume] 系統從睡眠恢復，等網路就緒後更新');
        waitForOnline(90 * 1000).then(() => poller.refreshAll(true));
      });
    } else {
      runSmoke();
    }
  });

  app.on('window-all-closed', () => {
    // 常駐系統列，不因視窗關閉而結束（smoke 模式除外）
    if (IS_SMOKE) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (lanServer) lanServer.stop();
    if (sysMetrics) sysMetrics.stop();
  });
}

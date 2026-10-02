'use strict';

/* ============================================================
   畫面邏輯：渲染帳號卡片、用量條、倒數計時，處理授權與設定
   ============================================================ */

const $ = (sel) => document.querySelector(sel);

const state = {
  accounts: [],
  settings: {},
  usage: {},
  version: '',
  authId: null,
  authAccountId: null,
  editingId: null,
  draggingId: null,
  lastSentHeight: 0,
};

const ICONS = {
  refresh: '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5l4 4L7 21H3v-4L16.5 3.5z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M9 6V4h6v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>',
  credit: '<svg viewBox="0 0 24 24"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/><line x1="6" y1="15" x2="10" y2="15"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>',
};

// ---------- 小工具 ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function levelOf(percent) {
  if (percent >= 85) return 'hot';
  if (percent >= 60) return 'warn';
  return 'ok';
}

const fmtClock = new Intl.DateTimeFormat('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false });
const fmtDate = new Intl.DateTimeFormat('zh-TW', { month: 'numeric', day: 'numeric' }); // 不放星期，同一列擠不下

function fmtReset(iso) {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = t - Date.now();
  if (diff <= 0) return '重置中…';
  const totalMin = Math.floor(diff / 60000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  // 倒數寫短一點，因為要跟標題擠在同一列
  let rel;
  if (d > 0) rel = `剩 ${d} 天 ${h} 時`;
  else if (h > 0) rel = `剩 ${h} 時 ${m} 分`;
  else rel = `剩 ${m} 分`;
  const when = new Date(t);
  const abs = diff > 20 * 3600 * 1000 ? `${fmtDate.format(when)} ${fmtClock.format(when)}` : fmtClock.format(when);
  return `${rel} · ${abs}`;
}

// 重置倒數的 HTML（放在標題同一列）：絕對時間獨立成 .abs，緊湊／精簡層級會把它藏起來
function resetInner(iso) {
  const text = fmtReset(iso);
  if (!text) return '';
  const [rel, abs] = text.split(' · ');
  return `<span class="rel">${esc(rel)}</span>${abs ? `<span class="abs"> · ${esc(abs)}</span>` : ''}`;
}

// 同一個帳號裡「週用量（全部）」和「週 · 模型」是同時重置的，倒數只在「全部」那條寫一次
function showResetFor(bucket, buckets) {
  if (!bucket.resetsAt) return false;
  if (bucket.kind !== 'weekly_scoped') return true;
  return !buckets.some((b) => b !== bucket && b.kind === 'weekly_all' && b.resetsAt);
}

function shortLabel(bucket) {
  if (bucket.kind === 'session') return `Session ${bucket.short || '5h'}`;
  if (bucket.kind === 'weekly_all') return '週用量';
  if (bucket.kind === 'weekly_scoped') return `週 · ${bucket.model}`;
  return bucket.label || '其他';
}

function miniKey(bucket) {
  if (bucket.short) return bucket.short;
  if (bucket.kind === 'session') return '5h';
  if (bucket.kind === 'weekly_all') return '週';
  return bucket.model || '其他';
}

const PROVIDER_BADGES = {
  claude: { cls: 'claude', text: 'CLAUDE' },
  codex: { cls: 'codex', text: 'CODEX' },
  demo: { cls: 'demo', text: '示範' },
};

// ---------- 渲染 ----------

function bucketHtml(bucket, compact, buckets = [bucket]) {
  const pct = Math.max(0, Number(bucket.percent) || 0);
  const level = levelOf(pct);
  const width = Math.min(100, pct);
  const shown = pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10;
  const label = compact ? shortLabel(bucket) : bucket.label;
  const reset = showResetFor(bucket, buckets) ? resetInner(bucket.resetsAt) : '';
  const resetTitle = reset ? ` title="${esc(fmtReset(bucket.resetsAt))} 重置"` : '';
  return `
    <div class="bucket">
      <div class="bucket-row1">
        <span class="bucket-label">${esc(label)}</span>
        ${reset ? `<span class="bucket-reset" data-resets-at="${esc(bucket.resetsAt)}"${resetTitle}>${reset}</span>` : ''}
        <span class="bucket-pct ${level}">${shown}%</span>
      </div>
      <div class="bar"><div class="bar-fill ${level}" style="width:${width}%"></div></div>
    </div>`;
}

// 收合狀態下的一行迷你摘要：5h 34%・週 71%・Fable 53%
function miniSummaryHtml(account) {
  const usage = state.usage[account.id];
  if (account.needsReauth) return '<span class="mini-note warn-text">需重新授權</span>';
  if (!usage) return '<span class="mini-note">…</span>';
  if (!usage.ok) return '<span class="mini-note warn-text">暫時抓不到</span>';
  const parts = usage.buckets.map((b) => {
    const pct = Math.max(0, Number(b.percent) || 0);
    return `<span class="mini-item">${esc(miniKey(b))} <b class="${levelOf(pct)}">${Math.round(pct)}%</b></span>`;
  });
  return `<div class="mini-usage" title="點左邊箭頭展開完整資訊">${parts.join('')}</div>`;
}

function cardHtml(account) {
  const compact = Boolean(state.settings.compact);
  const usage = state.usage[account.id];
  const editing = state.editingId === account.id;
  const collapsed = Boolean(account.collapsed);

  let body = '';
  if (account.needsReauth) {
    body = `
      <div class="card-note error">
        ${ICONS.alert}
        <span>授權已過期</span>
        <button class="btn small primary reauth-btn" data-action="reauth" data-id="${account.id}">重新授權</button>
        <button class="btn small" data-action="refresh-one" data-id="${account.id}" title="先用舊憑證再試一次連線，不用重新登入">先重試</button>
      </div>`;
  } else if (usage && usage.ok) {
    body = `<div class="buckets">${usage.buckets.map((b) => bucketHtml(b, compact, usage.buckets)).join('')}</div>`;
    if (usage.credits && Array.isArray(usage.credits.items) && usage.credits.items.length) {
      const parts = usage.credits.items.map((it) => `${esc(it.name)} <b>${esc(it.text)}</b>`).join('<span class="sep">·</span>');
      body += `<div class="card-note credits${usage.credits.level === 'hot' ? ' warn-text' : ''}">${ICONS.credit}<span>${parts}</span></div>`;
    }
    if (!compact) {
      const at = new Date(usage.fetchedAt);
      const ageMin = Math.round((Date.now() - usage.fetchedAt) / 60000);
      const stale = ageMin >= 20; // 跟 iPad 儀表板同一個標準：超過 20 分鐘沒更新就提醒
      body += `<div class="card-note meta${stale ? ' warn-text' : ''}">${ICONS.clock}<span>更新於 ${fmtClock.format(at)}${stale ? `（已 ${ageMin} 分鐘沒更新）` : ''}</span></div>`;
    }
  } else if (usage && !usage.ok) {
    body = `
      <div class="card-note error">
        ${ICONS.alert}
        <span>${esc(usage.error || '暫時抓不到資料')}</span>
        ${usage.needsReauth
          ? `<button class="btn small primary reauth-btn" data-action="reauth" data-id="${account.id}">重新授權</button>`
          : `<button class="btn small" data-action="refresh-one" data-id="${account.id}">重試</button>`}
      </div>`;
  } else {
    body = `<div class="card-note">${ICONS.clock}<span>正在讀取用量…</span></div>`;
  }

  const labelPart = editing
    ? `<input class="acc-label-input" data-id="${account.id}" value="${esc(account.label)}" maxlength="40" />`
    : `<span class="acc-label" title="${esc(account.email || account.label)}">${esc(account.label)}</span>`;

  const middlePart = collapsed
    ? miniSummaryHtml(account)
    : account.email && account.email !== account.label
      ? `<span class="acc-email">${esc(account.email)}</span>`
      : '<span class="acc-email"></span>';

  const badge = PROVIDER_BADGES[account.provider] || PROVIDER_BADGES.claude;

  return `
    <article class="card ${collapsed ? 'collapsed' : ''}" data-id="${account.id}" draggable="${editing ? 'false' : 'true'}">
      <div class="card-head">
        <button class="icon-btn collapse-btn ${collapsed ? 'is-collapsed' : ''}" title="${collapsed ? '展開' : '收合成一行'}" data-action="toggle-collapse" data-id="${account.id}">${ICONS.chevron}</button>
        <span class="provider-badge ${badge.cls}" title="${esc(account.planType || '')}">${badge.text}</span>
        ${labelPart}
        ${middlePart}
        <div class="card-actions">
          <button class="icon-btn" title="更新這個帳號" data-action="refresh-one" data-id="${account.id}">${ICONS.refresh}</button>
          <button class="icon-btn" title="重新命名" data-action="rename" data-id="${account.id}">${ICONS.edit}</button>
          <button class="icon-btn danger" title="移除帳號" data-action="remove" data-id="${account.id}">${ICONS.trash}</button>
        </div>
      </div>
      ${collapsed ? '' : body}
    </article>`;
}

// 頁尾版本號：有新版下載好了就變成「重新啟動更新」按鈕；下載中顯示進度
function footerVersionHtml() {
  const u = state.update || {};
  if (u.status === 'ready') {
    return `v${esc(state.version)} → <button class="btn small primary" data-action="install-update" title="只換程式本體，帳號與設定都會保留">重新啟動更新到 v${esc(u.version)}</button>`;
  }
  if (u.status === 'downloading') return `v${esc(state.version)} · 下載新版 v${esc(u.version)} ${u.percent || 0}%`;
  return `v${esc(state.version)}`;
}

function updateStatusText() {
  const u = state.update || {};
  if (u.supported === false) return '從原始碼執行時不會自動更新';
  if (u.status === 'checking') return '檢查中…';
  if (u.status === 'downloading') return `下載 v${u.version} 中 ${u.percent || 0}%`;
  if (u.status === 'ready') return `v${u.version} 已下載，重新啟動就會更新`;
  if (u.status === 'error') return `上次檢查失敗：${u.error || ''}`;
  if (u.checkedAt) return `已是最新版（${fmtClock.format(new Date(u.checkedAt))} 檢查）`;
  return '';
}

function emptyStateHtml() {
  return `
    <div class="empty-state">
      <span class="logo"></span>
      <h3>還沒有連接任何帳號</h3>
      <p>連接 Claude 或 ChatGPT Codex 帳號之後，這裡會即時顯示每個帳號的 Session（5 小時）與每週用量。</p>
      <div class="btn-col">
        <button class="btn primary" data-action="add">連接帳號</button>
        <button class="btn ghost" data-action="add-demo">先用示範資料看看</button>
      </div>
    </div>`;
}

function render() {
  const cards = $('#cards');
  if (state.accounts.length === 0) {
    cards.innerHTML = emptyStateHtml();
  } else {
    cards.innerHTML =
      state.accounts.map(cardHtml).join('') +
      `<button class="add-btn" data-action="add">＋ 新增帳號</button>`;
  }

  // 頁尾：最近一次成功更新時間
  const times = Object.values(state.usage)
    .filter((u) => u && u.ok)
    .map((u) => u.fetchedAt);
  $('#last-updated').textContent = times.length ? `最後更新 ${fmtClock.format(new Date(Math.max(...times)))}` : '';
  $('#footer-note').innerHTML = footerVersionHtml();

  // 標題列按鈕狀態
  $('#btn-pin').classList.toggle('active', Boolean(state.settings.alwaysOnTop));
  $('#btn-compact').classList.toggle('active', Boolean(state.settings.compact));

  if (state.editingId) {
    const input = cards.querySelector('.acc-label-input');
    if (input) {
      input.focus();
      input.select();
    }
  }

  applyLayout();
}

// ---------- 版面：依視窗大小決定欄數、密度層級、縮放比例 ----------

// 把某一組（層級／欄數／縮放）套到畫面上
function applyTier(tier, cols, zoom) {
  const body = document.body;
  body.classList.toggle('tight', tier === 'tight');
  body.classList.toggle('compact', tier === 'compact');
  body.style.setProperty('--cols', String(cols));
  const root = $('#root');
  root.style.zoom = String(zoom);
  root.style.height = ''; // 先放開，量自然高度
}

let layoutRaf = 0;
function applyLayout() {
  if (layoutRaf) return;
  layoutRaf = requestAnimationFrame(() => {
    layoutRaf = 0;
    const s = state.settings;
    const root = $('#root');
    const panelOpen = !$('#panel-auth').classList.contains('hidden') || !$('#panel-settings').classList.contains('hidden');
    const autoHeight = s.autoHeight !== false;

    const result = Layout.computeLayout({
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      columnsSetting: s.columns ?? 2,
      forceCompact: Boolean(s.compact),
      autoHeight,
      panelOpen,
      // 量「自然高度」：offsetHeight 回傳的是未縮放的 css px
      measure: (tier, cols, zoom) => {
        applyTier(tier, cols, zoom);
        return root.offsetHeight;
      },
    });

    applyTier(result.tier, result.cols, result.zoom);
    if (!autoHeight) {
      // 高度是使用者定的：卡片區填滿視窗，放不下的部分捲動
      root.style.height = `${result.availH / result.zoom}px`;
    } else if (Math.abs(result.height - state.lastSentHeight) > 1) {
      state.lastSentHeight = result.height;
      window.api.setWindowHeight(result.height);
    }
    window.__layoutDebug = {
      ...result,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      rootOffsetH: root.offsetHeight,
      rootRectH: Math.round(root.getBoundingClientRect().height),
      currentCSSZoom: root.currentCSSZoom,
    };
  });
}

window.addEventListener('resize', applyLayout);

// 每 30 秒刷新倒數文字（不重抓 API）
setInterval(() => {
  document.querySelectorAll('.bucket-reset[data-resets-at]').forEach((el) => {
    el.innerHTML = resetInner(el.dataset.resetsAt);
  });
}, 30 * 1000);

// ---------- 授權流程 ----------

// 面板裡有三個區塊：choose（選服務）/ claude（貼碼）/ codex（自動等待）
function showAuthSection(which) {
  ['choose', 'claude', 'codex'].forEach((k) => {
    $(`#auth-${k}`).classList.toggle('hidden', k !== which);
  });
  $('#panel-auth').classList.remove('hidden');
  applyLayout();
}

// 新增帳號的入口：先選要連哪種服務
function openAuthChooser() {
  state.authId = null;
  state.authAccountId = null;
  $('#auth-title').textContent = '連接帳號';
  showAuthSection('choose');
}

// 真正開始授權（新增時 accountId 為 null；重新授權時由主程序依帳號決定服務）
async function startAuth(accountId, provider) {
  const res = await window.api.beginAuth(accountId, provider);
  state.authId = res.authId;
  state.authAccountId = accountId;

  if (res.mode === 'auto') {
    $('#auth-title').textContent = accountId ? '重新授權 Codex 帳號' : '連接 ChatGPT Codex 帳號';
    $('#codex-status').textContent = '等待瀏覽器完成登入…';
    $('#auth-error-codex').classList.add('hidden');
    showAuthSection('codex');
  } else {
    $('#auth-title').textContent = accountId ? '重新授權 Claude 帳號' : '連接 Claude 帳號';
    $('#auth-code').value = '';
    $('#auth-error').classList.add('hidden');
    $('#btn-auth-done').disabled = false;
    showAuthSection('claude');
    $('#auth-code').focus();
  }
}

async function closeAuthPanel(cancel = true) {
  if (cancel && state.authId) await window.api.cancelAuth(state.authId);
  state.authId = null;
  state.authAccountId = null;
  $('#panel-auth').classList.add('hidden');
  applyLayout();
}

async function submitAuthCode() {
  const code = $('#auth-code').value.trim();
  const errEl = $('#auth-error');
  if (!code) {
    errEl.textContent = '請先把授權碼貼進來';
    errEl.classList.remove('hidden');
    return;
  }
  const btn = $('#btn-auth-done');
  btn.disabled = true;
  btn.textContent = '驗證中…';
  try {
    const result = await window.api.completeAuth(state.authId, code);
    if (result.ok) {
      await closeAuthPanel(false);
    } else {
      errEl.textContent = result.error || '授權失敗，請再試一次';
      errEl.classList.remove('hidden');
    }
  } finally {
    btn.disabled = false;
    btn.textContent = '完成授權';
  }
}

// ---------- 設定面板 ----------

// 區網儀表板的狀態列：顯示要在 iPad 輸入的網址，或啟動失敗的原因
function renderLan(info) {
  state.lan = info || state.lan || {};
  const lan = state.lan;
  const urlEl = $('#lan-url');
  const statusEl = $('#lan-status');
  const row = $('.lan-row');
  if (!lan.enabled) {
    row.classList.add('hidden');
    statusEl.textContent = '已關閉。勾起來就會在區網開一個網頁，給平板或手機當常駐監測畫面。';
    return;
  }
  row.classList.remove('hidden');
  if (!lan.running) {
    urlEl.textContent = lan.error || '啟動中…';
    statusEl.textContent = lan.error ? '啟動失敗，通常是埠號被占用；重開程式試試。' : '';
    return;
  }
  urlEl.textContent = lan.urls[0] || `http://（找不到區網 IP）:${lan.port}`;
  const others = lan.urls.slice(1);
  statusEl.textContent =
    '在同一個 Wi-Fi 的平板或手機瀏覽器輸入這個網址。' +
    (others.length ? `其他網卡：${others.join('、')}。` : '') +
    '第一次可能會跳出 Windows 防火牆詢問，請按「允許存取」。';
}

function openSettings() {
  const s = state.settings;
  $('#set-columns').value = String(s.columns ?? 2);
  $('#set-interval').value = String(s.refreshMinutes ?? 5);
  $('#set-opacity').value = String(Math.round((s.opacity ?? 1) * 100));
  $('#opacity-val').textContent = `${Math.round((s.opacity ?? 1) * 100)}%`;
  $('#set-transparent').checked = Boolean(s.transparent);
  $('#set-autoheight').checked = s.autoHeight !== false;
  $('#set-autostart').checked = Boolean(s.openAtLogin);
  $('#set-lan').checked = s.lanEnabled !== false;
  $('#set-autoupdate').checked = s.autoUpdate !== false;
  $('#update-status').textContent = updateStatusText();
  renderLan(state.lan);
  $('#app-version').textContent = `AI 用量監控 v${state.version}`;
  $('#panel-settings').classList.remove('hidden');
  applyLayout();
}

// ---------- 事件繫結 ----------

function bindEvents() {
  $('#btn-refresh').addEventListener('click', (e) => {
    const btn = e.currentTarget;
    btn.classList.add('spinning');
    setTimeout(() => btn.classList.remove('spinning'), 1500);
    window.api.refreshUsage(null);
  });

  $('#btn-pin').addEventListener('click', () => {
    window.api.updateSettings({ alwaysOnTop: !state.settings.alwaysOnTop });
  });

  $('#btn-compact').addEventListener('click', () => {
    window.api.updateSettings({ compact: !state.settings.compact });
  });

  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-hide').addEventListener('click', () => window.api.hideWindow());

  // 卡片區：事件代理
  $('#cards').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === 'add') openAuthChooser();
    if (action === 'add-demo') window.api.addDemoAccount();
    if (action === 'reauth') startAuth(id, null);
    if (action === 'refresh-one') window.api.refreshUsage(id);
    if (action === 'toggle-collapse') {
      const acc = state.accounts.find((a) => a.id === id);
      window.api.setAccountCollapsed(id, !(acc && acc.collapsed));
    }
    if (action === 'rename') {
      state.editingId = id;
      render();
    }
    if (action === 'remove') {
      const acc = state.accounts.find((a) => a.id === id);
      if (acc && confirm(`確定要移除「${acc.label}」嗎？\n（只是從這個小工具移除，不影響帳號本身）`)) {
        window.api.removeAccount(id);
      }
    }
  });

  // 拖曳卡片調整帳號順序
  const cardsEl = $('#cards');
  const clearDropMarks = () =>
    cardsEl.querySelectorAll('.drop-above, .drop-below').forEach((el) => el.classList.remove('drop-above', 'drop-below'));

  cardsEl.addEventListener('dragstart', (e) => {
    const card = e.target.closest && e.target.closest('.card');
    if (!card || e.target.closest('button, input')) {
      e.preventDefault();
      return;
    }
    state.draggingId = card.dataset.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', card.dataset.id); } catch { /* 某些平台不允許，無妨 */ }
  });

  cardsEl.addEventListener('dragover', (e) => {
    if (!state.draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clearDropMarks();
    const card = e.target.closest && e.target.closest('.card');
    if (!card || card.dataset.id === state.draggingId) return;
    const rect = card.getBoundingClientRect();
    card.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-above' : 'drop-below');
  });

  cardsEl.addEventListener('drop', (e) => {
    if (!state.draggingId) return;
    e.preventDefault();
    const target = e.target.closest && e.target.closest('.card');
    const ids = state.accounts.map((a) => a.id).filter((x) => x !== state.draggingId);
    if (target && target.dataset.id !== state.draggingId) {
      const rect = target.getBoundingClientRect();
      const above = e.clientY < rect.top + rect.height / 2;
      const idx = ids.indexOf(target.dataset.id);
      ids.splice(above ? idx : idx + 1, 0, state.draggingId);
    } else {
      ids.push(state.draggingId); // 拖到空白處 = 移到最後
    }
    window.api.reorderAccounts(ids);
  });

  cardsEl.addEventListener('dragend', () => {
    state.draggingId = null;
    clearDropMarks();
    cardsEl.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
  });

  // 重新命名：Enter 確認、Esc 取消、失焦確認
  $('#cards').addEventListener('keydown', (e) => {
    if (!e.target.classList.contains('acc-label-input')) return;
    if (e.key === 'Enter') e.target.blur();
    if (e.key === 'Escape') {
      state.editingId = null;
      render();
    }
  });
  $('#cards').addEventListener(
    'blur',
    (e) => {
      if (!e.target.classList.contains('acc-label-input')) return;
      const id = e.target.dataset.id;
      const value = e.target.value.trim();
      state.editingId = null;
      if (value) window.api.renameAccount(id, value);
      else render();
    },
    true
  );

  // 授權面板：選擇服務
  document.querySelectorAll('.provider-choice').forEach((btn) => {
    btn.addEventListener('click', () => startAuth(null, btn.dataset.provider));
  });
  $('#btn-choose-cancel').addEventListener('click', () => closeAuthPanel(false));

  // 授權面板：Claude 貼碼
  const bindCopyUrl = (btnId) => {
    $(btnId).addEventListener('click', async () => {
      await window.api.copyAuthUrl(state.authId);
      const btn = $(btnId);
      btn.textContent = '已複製！';
      setTimeout(() => (btn.textContent = '複製授權連結'), 1500);
    });
  };
  bindCopyUrl('#btn-copy-url');
  bindCopyUrl('#btn-copy-url-codex');
  $('#btn-auth-cancel').addEventListener('click', () => closeAuthPanel(true));
  $('#btn-auth-done').addEventListener('click', submitAuthCode);
  $('#auth-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitAuthCode();
  });

  // 授權面板：Codex 取消
  $('#btn-codex-cancel').addEventListener('click', () => closeAuthPanel(true));

  // 設定面板
  $('#set-columns').addEventListener('change', (e) => {
    window.api.updateSettings({ columns: Number(e.target.value) });
  });
  $('#set-interval').addEventListener('change', (e) => {
    window.api.updateSettings({ refreshMinutes: Number(e.target.value) });
  });
  $('#set-opacity').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    $('#opacity-val').textContent = `${v}%`;
    window.api.updateSettings({ opacity: v / 100 });
  });
  $('#set-transparent').addEventListener('change', (e) => {
    window.api.updateSettings({ transparent: e.target.checked });
  });
  $('#set-autostart').addEventListener('change', (e) => {
    window.api.updateSettings({ openAtLogin: e.target.checked });
  });
  $('#set-lan').addEventListener('change', (e) => {
    window.api.updateSettings({ lanEnabled: e.target.checked });
    renderLan({ ...state.lan, enabled: e.target.checked, running: false, error: null });
  });
  $('#set-autoupdate').addEventListener('change', (e) => window.api.updateSettings({ autoUpdate: e.target.checked }));
  $('#btn-check-update').addEventListener('click', async () => {
    state.update = await window.api.checkUpdate();
    $('#update-status').textContent = updateStatusText();
  });
  // 頁尾的「重新啟動更新」按鈕
  $('#footer-note').addEventListener('click', (e) => {
    if (e.target.closest('[data-action="install-update"]')) window.api.installUpdate();
  });
  window.api.on('update:state', (u) => {
    state.update = { ...(state.update || {}), ...u };
    $('#footer-note').innerHTML = footerVersionHtml();
    if (!$('#panel-settings').classList.contains('hidden')) $('#update-status').textContent = updateStatusText();
  });
  $('#btn-lan-copy').addEventListener('click', async () => {
    const ok = await window.api.copyLanUrl();
    $('#btn-lan-copy').textContent = ok ? '已複製' : '沒有網址';
    setTimeout(() => ($('#btn-lan-copy').textContent = '複製網址'), 1500);
  });
  window.api.on('lan:changed', (info) => renderLan(info));
  $('#set-autoheight').addEventListener('change', (e) => {
    state.lastSentHeight = 0; // 重新打開自動高度時強制送一次
    window.api.updateSettings({ autoHeight: e.target.checked });
  });

  // 右下角拉柄：把滑鼠從按下到現在的位移回報給主程序，由它改視窗大小
  const grip = $('#grip');
  let gripStart = null;
  let gripRaf = 0;
  let gripLast = null;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    gripStart = { x: e.screenX, y: e.screenY };
    window.api.resizeDrag('start', 0, 0);
  });
  grip.addEventListener('pointermove', (e) => {
    if (!gripStart) return;
    gripLast = { dx: e.screenX - gripStart.x, dy: e.screenY - gripStart.y };
    if (!gripRaf) {
      gripRaf = requestAnimationFrame(() => {
        gripRaf = 0;
        if (gripStart && gripLast) window.api.resizeDrag('move', gripLast.dx, gripLast.dy);
      });
    }
  });
  const gripEnd = (e) => {
    if (!gripStart) return;
    const { x, y } = gripStart;
    gripStart = null;
    cancelAnimationFrame(gripRaf);
    gripRaf = 0;
    window.api.resizeDrag('end', e.screenX - x, e.screenY - y);
  };
  grip.addEventListener('pointerup', gripEnd);
  grip.addEventListener('pointercancel', gripEnd);
  grip.addEventListener('dblclick', () => {
    state.lastSentHeight = 0;
    window.api.updateSettings({ autoHeight: true });
  });
  $('#btn-demo').addEventListener('click', () => window.api.addDemoAccount());
  $('#btn-quit').addEventListener('click', () => {
    if (confirm('確定要完全結束程式嗎？（結束後就不會再更新用量）')) window.api.quitApp();
  });
  $('#btn-settings-close').addEventListener('click', () => {
    $('#panel-settings').classList.add('hidden');
    applyLayout();
  });
}

// ---------- 啟動 ----------

async function init() {
  bindEvents();

  const snapshot = await window.api.getState();
  state.accounts = snapshot.accounts;
  state.settings = snapshot.settings;
  state.usage = snapshot.usage || {};
  state.version = snapshot.version || '';
  state.lan = snapshot.lan || {};
  state.update = snapshot.update || {};

  window.api.on('accounts:changed', (accounts) => {
    state.accounts = accounts;
    render();
  });
  window.api.on('usage:update', ({ accountId, result }) => {
    state.usage[accountId] = result;
    if (!state.editingId) render();
  });
  window.api.on('settings:changed', (settings) => {
    state.settings = settings;
    render();
  });
  // Codex 自動授權的結果（成功自動關面板；失敗顯示原因）
  window.api.on('auth:auto', (payload) => {
    if (!payload || payload.authId !== state.authId) return;
    if (payload.ok) {
      state.authId = null;
      state.authAccountId = null;
      $('#panel-auth').classList.add('hidden');
      applyLayout();
    } else {
      $('#codex-status').textContent = '登入沒有完成';
      const el = $('#auth-error-codex');
      el.textContent = payload.error || '授權失敗，請再試一次';
      el.classList.remove('hidden');
      applyLayout();
    }
  });

  render();
}

init();

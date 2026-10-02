/* ============================================================
   iPad 儀表板畫面邏輯（區網網頁版）
   刻意用舊寫法（ES5：var／function／XHR），iOS 9～10 的 Safari 也能跑。
   每 2 秒向電腦要一次最新資料，畫面本地每秒更新時鐘與倒數。
   ============================================================ */
(function () {
  'use strict';

  var POLL_MS = 2000;
  var HISTORY = 120; // 折線保留幾個點（2 秒一點 → 4 分鐘）
  var state = { data: null, online: false, lastOkAt: 0, failures: 0, order: null, sorting: false };
  var history = { cpu: [], gpu: [], ram: [], vram: [], disk: {} }; // disk 以實體碟編號為 key
  var lastIo = null, lastIoAt = 0; // 最近一筆有內容的硬碟讀寫資料（取樣偶爾失敗時沿用）

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function levelOf(p) { return p >= 85 ? 'hot' : p >= 60 ? 'warn' : 'ok'; }
  function tempLevel(t) { return t >= 85 ? 'hot' : t >= 70 ? 'warn' : ''; }
  function gb(bytes) { return (bytes / 1073741824).toFixed(1); }
  function fmtPct(v) { return v === null || v === undefined ? '–' : String(Math.round(v)); }
  // 讀寫速度：1 MB/s 以上顯示 MB/s（一位小數），以下顯示 KB/s
  function fmtBps(v) {
    if (!v || v < 512) return '0 <small>KB/s</small>';
    if (v < 1048576) return Math.round(v / 1024) + ' <small>KB/s</small>';
    return (v / 1048576).toFixed(v >= 104857600 ? 0 : 1) + ' <small>MB/s</small>';
  }
  // 每次存取平均等多久：SSD 通常 <1 ms、傳統硬碟 5～15 ms；超過 20 ms 就開始卡
  function respLevel(ms) { return ms >= 50 ? 'hot' : ms >= 20 ? 'warn' : ''; }
  function fmtMs(ms) { return ms >= 10 ? String(Math.round(ms)) : ms.toFixed(1); }

  // ---------- 資料抓取 ----------

  function poll() {
    var xhr = new XMLHttpRequest();
    var done = false;
    xhr.open('GET', '/api/state?t=' + Date.now(), true);
    xhr.timeout = 4000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || done) return;
      done = true;
      if (xhr.status === 200) {
        try {
          state.data = JSON.parse(xhr.responseText);
          state.online = true;
          state.lastOkAt = Date.now();
          state.failures = 0;
          render();
        } catch (e) {
          onFail();
        }
      } else {
        onFail();
      }
      schedule();
    };
    xhr.ontimeout = xhr.onerror = function () {
      if (done) return;
      done = true;
      onFail();
      schedule();
    };
    try { xhr.send(null); } catch (e) { if (!done) { done = true; onFail(); schedule(); } }
  }

  function onFail() {
    state.failures += 1;
    state.online = false;
    renderConn();
  }

  function schedule() {
    // 連不上就慢慢退避到最多 10 秒，恢復後回到 2 秒
    var wait = state.online ? POLL_MS : Math.min(10000, POLL_MS * (1 + state.failures));
    setTimeout(poll, wait);
  }

  // ---------- 畫面 ----------

  function renderConn() {
    var dot = $('conn-dot');
    var txt = $('conn-text');
    if (state.online) {
      dot.className = 'dot on';
      txt.textContent = '已連線 · 每 2 秒更新';
    } else {
      dot.className = 'dot off';
      txt.textContent = state.lastOkAt ? '連不上電腦，重試中…' : '正在連線電腦…';
    }
  }

  function renderClock() {
    var d = new Date();
    $('clock').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  // short=true 只回「剩 2 時 57 分」，不帶絕對時間（卡片欄位窄）
  function fmtReset(iso, short) {
    if (!iso) return '';
    var t = new Date(iso).getTime();
    if (!isFinite(t)) return '';
    var diff = t - Date.now();
    if (diff <= 0) return '重置中…';
    var totalMin = Math.floor(diff / 60000);
    var d = Math.floor(totalMin / 1440);
    var h = Math.floor((totalMin % 1440) / 60);
    var m = totalMin % 60;
    var when = new Date(t);
    var clock = pad2(when.getHours()) + ':' + pad2(when.getMinutes());
    var rel;
    if (d > 0) rel = '剩 ' + d + ' 天 ' + h + ' 時';
    else if (h > 0) rel = '剩 ' + h + ' 時 ' + m + ' 分';
    else rel = '剩 ' + m + ' 分';
    if (short) return rel;
    if (d > 0) return rel + ' · ' + (when.getMonth() + 1) + '/' + when.getDate() + ' ' + clock;
    return rel + ' · ' + clock;
  }

  function fmtAge(ts) {
    if (!ts) return '';
    var s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return '剛更新';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分前';
    return Math.floor(m / 60) + ' 小時前';
  }

  function badgeFor(provider) {
    if (provider === 'codex') return '<span class="badge codex">CODEX</span>';
    if (provider === 'demo') return '<span class="badge demo">示範</span>';
    return '<span class="badge">CLAUDE</span>';
  }

  // 一格額度：名稱／大百分比／細條／剩多久重置
  //   name 為空 → 這張卡沒有這種額度，留白但佔位（讓每張卡的三欄對齊）
  //   showReset=false → 不寫重置（分模型額度跟本週同時重置，只在本週寫一次）
  function quotaCell(name, bucket, showReset) {
    if (!name) return '<div class="q blank"></div>';
    if (!bucket) return '<div class="q none"><div class="q-name">' + esc(name) + '</div><div class="q-pct">–</div></div>';
    var lv = levelOf(bucket.percent);
    // 倒數放在標題同一行靠右（省一行高度，五張卡才放得下）
    var html = '<div class="q"><div class="q-head"><span class="q-name">' + esc(name) + '</span>';
    if (showReset) html += '<span class="q-reset" data-reset="' + esc(bucket.resetsAt || '') + '">' + fmtReset(bucket.resetsAt, true) + '</span>';
    html += '</div><div class="q-pct ' + lv + '">' + Math.round(bucket.percent) + '<small>%</small></div>';
    html += '<div class="bar"><div class="fill ' + lv + '" style="width:' + Math.min(100, bucket.percent) + '%"></div></div></div>';
    return html;
  }

  // 本週欄：兩列（全部模型／分模型），每列「名稱｜進度條｜百分比」同一行，重置只寫一次
  function weekCell(week, scoped) {
    if (!week) return '<div class="q week none"><div class="q-name">本週</div><div class="q-pct">–</div></div>';
    var row = function (name, b) {
      var lv = levelOf(b.percent);
      return '<div class="wk-row"><span class="wk-name">' + esc(name) + '</span>' +
        '<div class="bar"><div class="fill ' + lv + '" style="width:' + Math.min(100, b.percent) + '%"></div></div>' +
        '<span class="wk-pct ' + lv + '">' + Math.round(b.percent) + '<small>%</small></span></div>';
    };
    var html = '<div class="q week"><div class="q-head"><span class="q-name">本週</span>';
    html += '<span class="q-reset" data-reset="' + esc(week.resetsAt || '') + '">' + fmtReset(week.resetsAt, true) + '</span></div>';
    html += row(scoped ? '全部' : '全部模型', week);
    if (scoped) html += row(scoped.model || '模型', scoped);
    html += '</div>';
    return html;
  }

  // ---------- 卡片順序（iPad 上長按拖曳後記住）----------
  function loadLocalOrder() {
    try { return JSON.parse(window.localStorage.getItem('dashOrder') || 'null'); } catch (e) { return null; }
  }
  // 優先：這台裝置剛拖完的 → 電腦記的 → 這台裝置以前記的；沒列到的帳號照原本順序排最後
  function applyOrder(list, serverOrder) {
    var order = state.order || (serverOrder && serverOrder.length ? serverOrder : null) || loadLocalOrder();
    if (!order || !order.length) return list;
    var pos = {};
    for (var i = 0; i < order.length; i++) pos[order[i]] = i;
    var known = [], rest = [];
    for (var j = 0; j < list.length; j++) (pos[list[j].id] === undefined ? rest : known).push(list[j]);
    known.sort(function (a, b) { return pos[a.id] - pos[b.id]; });
    return known.concat(rest);
  }
  function saveOrder(ids) {
    state.order = ids;
    try { window.localStorage.setItem('dashOrder', JSON.stringify(ids)); } catch (e) { /* 私密瀏覽等情況存不了就算了 */ }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/order', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify({ ids: ids }));
    } catch (e) { /* 舊版電腦端不支援就只記在這台裝置 */ }
  }

  function renderAccounts() {
    if (state.sorting) return; // 正在拖曳：先不要重畫，不然卡片會被換掉
    var data = state.data;
    var accounts = applyOrder(data.accounts || [], data.order);
    var box = $('accounts');
    $('usage-empty').className = accounts.length ? 'empty hidden' : 'empty';
    // 帳號很多（6 個以上）預設切成「額度置頂」版面（一列三張，系統方塊縮成下排）
    // 網址加 ?layout=rows / grouped / wall 可切換其他版面（見 style.css 說明）
    var many = accounts.length > 5;
    var layoutMatch = /[?&]layout=(rows|grouped|top|wall)\b/.exec(window.location.search || '');
    var layout = many ? (layoutMatch ? layoutMatch[1] : 'top') : '';
    if (layout === 'wall') layout = '';
    document.body.className = (many ? 'many' : '') + (layout ? ' ' + layout : '');
    var order = { claude: 0, codex: 1 };
    if (layout === 'grouped') {
      // 依服務分組：左欄 Claude、右欄其他服務；各組內保持原本順序
      accounts = accounts.slice().sort(function (x, y) {
        return (order[x.provider] === undefined ? 9 : order[x.provider]) - (order[y.provider] === undefined ? 9 : order[y.provider]);
      });
    }
    var cardsHtml = [];
    var html = '';
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i];
      var u = (data.usage || {})[a.id];
      var stale = u && u.fetchedAt && Date.now() - u.fetchedAt > 20 * 60 * 1000;
      html += '<div class="card' + (stale ? ' stale' : '') + '" data-id="' + esc(a.id) + '">';
      html += '<div class="card-head">' + badgeFor(a.provider) + '<span class="label">' + esc(a.label) + '</span>';
      html += '<span class="age">' + (u ? fmtAge(u.fetchedAt) : '') + '</span></div>';
      if (a.needsReauth) {
        html += '<div class="err">授權過期，請在電腦上重新授權</div>';
      } else if (!u) {
        html += '<div class="line">尚無資料</div>';
      } else if (!u.ok) {
        html += '<div class="err">' + esc(u.error || '抓取失敗') + '</div>';
      } else {
        // 三欄等寬：5 小時｜本週（全部模型）｜分模型週額度（例如 Fable）；沒有的留白佔位
        var session = null, week = null, scoped = null;
        for (var j = 0; j < u.buckets.length; j++) {
          var b = u.buckets[j];
          if (b.kind === 'session' && !session) session = b;
          else if (b.kind === 'weekly_all' && !week) week = b;
          else if (b.kind === 'weekly_scoped' && (!scoped || b.percent > scoped.percent)) scoped = b; // 多個模型額度取最緊的
        }
        if (!week && scoped) { week = scoped; scoped = null; }
        // 左「5 小時」大數字；右「本週」兩列（全部／分模型）
        html += '<div class="quota">' + quotaCell('5 小時', session, true) + weekCell(week, scoped) + '</div>';
      }
      html += '</div>';
      cardsHtml.push({ provider: a.provider, html: html });
      html = '';
    }
    if (layout === 'grouped') {
      var left = '', right = '';
      for (var g = 0; g < cardsHtml.length; g++) {
        if (cardsHtml[g].provider === 'claude') left += cardsHtml[g].html; else right += cardsHtml[g].html;
      }
      box.innerHTML = '<div class="cards-col"><h3>Claude</h3>' + left + '</div><div class="cards-col"><h3>Codex</h3>' + right + '</div>';
    } else {
      for (var c = 0; c < cardsHtml.length; c++) html += cardsHtml[c].html;
      box.innerHTML = html;
    }
  }

  function tickResets() {
    var els = document.querySelectorAll('[data-reset]');
    for (var i = 0; i < els.length; i++) els[i].textContent = fmtReset(els[i].getAttribute('data-reset'), true);
  }

  function pushHistory(key, v) {
    var arr = typeof key === 'string' ? history[key] : key;
    arr.push(v === null || v === undefined ? null : v);
    if (arr.length > HISTORY) arr.shift();
  }

  function drawSpark(id, arr, color) {
    var c = $(id);
    if (!c || !c.getContext) return;
    var dpr = window.devicePixelRatio || 1;
    var w = c.clientWidth || 300;
    var h = c.clientHeight || 44;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    var ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();
    if (arr.length < 2) return;
    var step = w / (HISTORY - 1);
    var x0 = w - (arr.length - 1) * step;
    ctx.beginPath();
    var started = false;
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v === null) { started = false; continue; }
      var x = x0 + i * step;
      var y = h - 2 - (Math.min(100, Math.max(0, v)) / 100) * (h - 4);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // 線下方淡淡填色
    ctx.lineTo(x0 + (arr.length - 1) * step, h);
    ctx.lineTo(x0, h);
    ctx.closePath();
    ctx.fillStyle = color.replace('1)', '0.12)');
    ctx.fill();
  }

  function colorOf(p) {
    var lv = levelOf(p || 0);
    return lv === 'hot' ? 'rgba(240,86,74,1)' : lv === 'warn' ? 'rgba(242,177,62,1)' : 'rgba(55,211,165,1)';
  }

  function renderSystem(keepHistory) {
    var push = keepHistory ? function () {} : pushHistory;
    var sys = state.data.system || {};
    var cpu = sys.cpu || {};
    var mem = sys.mem || {};
    var gpu = sys.gpu;
    var lhm = sys.lhm;

    // CPU
    $('cpu-pct').textContent = fmtPct(cpu.pct);
    $('cpu-model').textContent = (cpu.model || '').replace(/\(R\)|\(TM\)|CPU|@.*$|\d+th Gen|Intel|AMD|Core|Ryzen/g, '').replace(/\s+/g, ' ').trim() + (cpu.count ? ' · ' + cpu.count + ' 執行緒' : '');
    var cpuTemp = lhm && lhm.cpuTempC !== null && lhm.cpuTempC !== undefined ? lhm.cpuTempC : null;
    var ct = $('cpu-temp');
    ct.textContent = cpuTemp === null ? '' : Math.round(cpuTemp) + '°C';
    ct.className = 'temp ' + (cpuTemp === null ? '' : tempLevel(cpuTemp));
    var cores = cpu.cores || [];
    var coresBox = $('cpu-cores');
    if (coresBox.childNodes.length !== cores.length) {
      var ch = '';
      for (var i = 0; i < cores.length; i++) ch += '<span><i></i></span>';
      coresBox.innerHTML = ch;
    }
    for (var k = 0; k < cores.length; k++) {
      var bar = coresBox.childNodes[k].firstChild;
      bar.style.height = Math.max(4, cores[k]) + '%';
      bar.className = levelOf(cores[k]);
    }
    push('cpu', cpu.pct);
    drawSpark('spark-cpu', history.cpu, colorOf(cpu.pct));

    // GPU
    if (gpu) {
      $('gpu-pct').textContent = fmtPct(gpu.utilPct);
      $('gpu-name').textContent = (gpu.name || '').replace(/NVIDIA |GeForce /g, '') + ((sys.gpus || []).length > 1 ? '（＋' + (sys.gpus.length - 1) + ' 張）' : '');
      var gt = $('gpu-temp');
      gt.textContent = gpu.tempC === null ? '' : Math.round(gpu.tempC) + '°C';
      gt.className = 'temp ' + (gpu.tempC === null ? '' : tempLevel(gpu.tempC));
      var parts = [];
      if (gpu.powerW !== null) parts.push(Math.round(gpu.powerW) + ' W' + (gpu.powerLimitW ? ' / ' + Math.round(gpu.powerLimitW) : ''));
      if (gpu.fanPct !== null) parts.push('風扇 ' + Math.round(gpu.fanPct) + '%');
      if (gpu.clockMhz !== null) parts.push(Math.round(gpu.clockMhz) + ' MHz');
      $('gpu-line').textContent = parts.join(' · ');
      var vramPct = gpu.vramTotalMb ? (100 * gpu.vramUsedMb) / gpu.vramTotalMb : null;
      $('vram-pct').textContent = fmtPct(vramPct);
      $('vram-sub').textContent = (gpu.vramUsedMb / 1024).toFixed(1) + ' / ' + (gpu.vramTotalMb / 1024).toFixed(0) + ' GB';
      setFill('vram-fill', vramPct);
      push('gpu', gpu.utilPct);
      push('vram', vramPct);
      drawSpark('spark-gpu', history.gpu, colorOf(gpu.utilPct));
      drawSpark('spark-vram', history.vram, colorOf(vramPct));
    } else {
      $('gpu-pct').textContent = '–';
      $('gpu-name').textContent = sys.gpuAvailable === false ? '沒有 NVIDIA 顯卡' : '讀取中…';
      $('vram-pct').textContent = '–';
      $('vram-sub').textContent = '';
    }

    // RAM
    $('ram-pct').textContent = fmtPct(mem.pct);
    $('ram-sub').textContent = mem.totalBytes ? gb(mem.usedBytes) + ' / ' + gb(mem.totalBytes) + ' GB' : '';
    setFill('ram-fill', mem.pct);
    push('ram', mem.pct);
    drawSpark('spark-ram', history.ram, colorOf(mem.pct));

    // 硬碟：每顆「實體碟」一列 → 槽號＋型號｜忙碌％（Task Manager 的「使用中時間」）｜讀／寫速度｜回應｜剩餘空間
    //   有讀寫資料（Windows 效能計數器）才有這種列；沒有就退回舊的「每個槽剩多少」
    var disks = sys.disks || [];
    var io = sys.diskIo || [];
    // 電腦那端偶爾一次抓不到讀寫資料 → 先沿用最近 30 秒內的，不要在兩種版面之間跳
    if (io.length) { lastIo = io; lastIoAt = Date.now(); }
    else if (lastIo && Date.now() - lastIoAt < 30000) io = lastIo;
    var dh = '';
    var totalRead = 0, totalWrite = 0, worstBusy = 0;
    if (io.length) {
      var spaceOf = {};
      for (var s0 = 0; s0 < disks.length; s0++) spaceOf[disks[s0].drive] = disks[s0];
      for (var d = 0; d < io.length; d++) {
        var dk = io[d];
        var used = 0, total = 0;
        for (var l = 0; l < dk.letters.length; l++) {
          var sp = spaceOf[dk.letters[l]];
          if (sp) { used += sp.usedBytes; total += sp.totalBytes; }
        }
        totalRead += dk.readBps; totalWrite += dk.writeBps;
        if (dk.busyPct > worstBusy) worstBusy = dk.busyPct;
        var lv = levelOf(dk.busyPct);
        var rl = respLevel(dk.respMs);
        dh += '<div class="dk"><span class="dk-name"><b>' + esc(dk.letters.join(' ') || ('#' + dk.index)) + '</b>' + esc(dk.name) + '</span>';
        dh += '<span class="dk-busy"><span class="bar"><span class="fill ' + lv + '" style="width:' + Math.min(100, dk.busyPct) + '%"></span></span><em class="' + lv + '">' + Math.round(dk.busyPct) + '<small>%</small></em></span>';
        dh += '<canvas class="dk-spark" id="dk-spark-' + dk.index + '"></canvas>';
        dh += '<span class="dk-io' + (dk.readBps < 512 ? ' zero' : '') + '">讀 <b>' + fmtBps(dk.readBps) + '</b></span>';
        dh += '<span class="dk-io' + (dk.writeBps < 512 ? ' zero' : '') + '">寫 <b>' + fmtBps(dk.writeBps) + '</b></span>';
        dh += '<span class="dk-resp ' + rl + '">回應 <b>' + fmtMs(dk.respMs) + '<small>ms</small></b>' + (dk.queue >= 2 ? ' <i>排隊 ' + dk.queue + '</i>' : '') + '</span>';
        dh += '<span class="dk-space">' + (total ? '剩 ' + gb(total - used) + ' <small>GB</small>' : '') + '</span></div>';
      }
      $('disks').innerHTML = dh;
      for (var d1 = 0; d1 < io.length; d1++) {
        var k1 = io[d1].index;
        if (!history.disk[k1]) history.disk[k1] = [];
        push(history.disk[k1], io[d1].busyPct);
        drawSpark('dk-spark-' + k1, history.disk[k1], colorOf(io[d1].busyPct));
      }
    } else {
      for (var d2x = 0; d2x < disks.length; d2x++) {
        var dk2 = disks[d2x];
        dh += '<div class="disk"><b>' + esc(dk2.drive) + '</b>' + gb(dk2.usedBytes) + ' / ' + gb(dk2.totalBytes) + ' GB';
        dh += '<div class="bar"><div class="fill ' + levelOf(dk2.pct) + '" style="width:' + dk2.pct + '%"></div></div></div>';
      }
      $('disks').innerHTML = dh;
    }

    // 溫度／風扇小標籤（有裝 LibreHardwareMonitor 才有）：主機板幾顆、硬碟每顆一個、有在轉的風扇
    var chips = '';
    var chip = function (name, value, unit, level) {
      return '<span class="chip ' + (level || '') + '">' + esc(name) + '<b>' + value + unit + '</b></span>';
    };
    if (lhm) {
      var bt = lhm.boardTemps || [];
      var wantBoard = ['System', 'PCH', 'VRM MOS'];
      var picked = 0;
      for (var w = 0; w < wantBoard.length; w++) {
        for (var t = 0; t < bt.length; t++) {
          if (bt[t].name === wantBoard[w]) { chips += chip(wantBoard[w] === 'System' ? '主機板' : wantBoard[w], Math.round(bt[t].tempC), '°', tempLevel(bt[t].tempC)); picked++; break; }
        }
      }
      if (!picked) for (var t2 = 0; t2 < bt.length && t2 < 3; t2++) chips += chip(bt[t2].name, Math.round(bt[t2].tempC), '°', tempLevel(bt[t2].tempC));
      var dt = lhm.diskTemps || [];
      for (var d2 = 0; d2 < dt.length && d2 < 3; d2++) chips += chip(dt[d2].name, Math.round(dt[d2].tempC), '°', tempLevel(dt[d2].tempC));
      var fn = lhm.fans || [];
      for (var f = 0; f < fn.length && f < 3; f++) chips += chip(fn[f].name.replace(/\s*Fan\s*/i, ' 風扇 ').replace(/\s+$/, ''), fn[f].rpm, ' rpm', '');
    }
    $('temps').innerHTML = chips;
    var dsub = $('disk-sub');
    if (io.length) {
      dsub.innerHTML = '讀 ' + fmtBps(totalRead) + ' · 寫 ' + fmtBps(totalWrite) + (worstBusy >= 60 ? ' · <em class="' + levelOf(worstBusy) + '">硬碟忙碌</em>' : '');
    } else {
      dsub.textContent = sys.diskIoAvailable === false ? '這台電腦讀不到硬碟讀寫速度' : '';
    }
    $('lhm-hint').textContent = sys.lhmAvailable === false
      ? '想看 CPU 溫度／風扇／主機板：在電腦安裝免費的 LibreHardwareMonitor，打開 Options → Remote Web Server → Run，這裡就會自動出現。'
      : '';

    // 開機時間
    var up = sys.uptimeSec || 0;
    var days = Math.floor(up / 86400);
    var hrs = Math.floor((up % 86400) / 3600);
    var mins = Math.floor((up % 3600) / 60);
    $('uptime').textContent = '開機 ' + (days ? days + ' 天 ' : '') + hrs + ' 時 ' + mins + ' 分';
    $('host').textContent = sys.host ? sys.host + (state.data.version ? ' · v' + state.data.version : '') : '';
  }

  function setFill(id, pct) {
    var el = $(id);
    el.style.width = (pct === null || pct === undefined ? 0 : Math.min(100, pct)) + '%';
    el.className = 'fill ' + levelOf(pct || 0);
  }

  function render() {
    renderConn();
    renderAccounts();
    renderSystem();
  }

  // ---------- 拖曳排序：長按卡片 0.3 秒 → 浮起 → 拖到別張卡上就換位 → 放開記住 ----------
  // 手指（iPad）與滑鼠（電腦預覽）都支援；舊 iOS 沒有 Pointer Events，所以用 touch＋mouse 兩套
  var drag = { card: null, timer: null, active: false, startX: 0, startY: 0, offX: 0, offY: 0 };
  function pointOf(e) {
    var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    return { x: t.clientX, y: t.clientY };
  }
  function cardOf(el) {
    while (el && el !== document.body) {
      if (el.className && typeof el.className === 'string' && /(^|\s)card(\s|$)/.test(el.className)) return el;
      el = el.parentNode;
    }
    return null;
  }
  function cancelLongPress() {
    if (drag.timer) { clearTimeout(drag.timer); drag.timer = null; }
  }
  function dragStart(e) {
    var card = cardOf(e.target);
    if (!card || drag.active) return;
    cancelLongPress();
    var p = pointOf(e);
    drag.card = card; drag.startX = p.x; drag.startY = p.y;
    drag.timer = setTimeout(function () {
      drag.timer = null;
      var r = card.getBoundingClientRect();
      drag.offX = p.x - r.left; drag.offY = p.y - r.top;
      drag.active = true; state.sorting = true;
      card.className += ' lifted';
      $('accounts').className += ' sorting';
      placeCard(p);
    }, 300);
  }
  // 讓浮起的卡跟著手指：先清掉位移量回原位，再算「原位 → 手指」的差
  function placeCard(p) {
    var card = drag.card;
    card.style.webkitTransform = card.style.transform = '';
    var r = card.getBoundingClientRect();
    var dx = p.x - drag.offX - r.left, dy = p.y - drag.offY - r.top;
    card.style.webkitTransform = card.style.transform = 'translate(' + dx + 'px,' + dy + 'px) scale(1.03)';
    return r;
  }
  function dragMove(e) {
    var p = pointOf(e);
    if (drag.timer) {
      // 還沒長按到：手指先動了（例如在捲動）就取消
      if (Math.abs(p.x - drag.startX) > 8 || Math.abs(p.y - drag.startY) > 8) cancelLongPress();
      return;
    }
    if (!drag.active) return;
    if (e.preventDefault) e.preventDefault();
    var card = drag.card;
    var mine = placeCard(p);
    var over = cardOf(document.elementFromPoint(p.x, p.y)); // 浮起的卡 pointer-events:none，所以點到的是底下那張
    if (!over || over === card || over.parentNode !== card.parentNode) return;
    var siblings = card.parentNode.children;
    var from = -1, to = -1;
    for (var i = 0; i < siblings.length; i++) { if (siblings[i] === card) from = i; if (siblings[i] === over) to = i; }
    var r = over.getBoundingClientRect();
    // 同一列：看手指過了對方的左右中線沒有；不同列：看上下中線。只在「越過中線」才換位，不會抖
    var sameRow = Math.abs(r.top - mine.top) < r.height / 2;
    var beyond = sameRow ? p.x > r.left + r.width / 2 : p.y > r.top + r.height / 2;
    if (from < to && beyond) card.parentNode.insertBefore(card, over.nextSibling);
    else if (from > to && !beyond) card.parentNode.insertBefore(card, over);
    else return;
    placeCard(p);
  }
  function dragEnd() {
    cancelLongPress();
    if (!drag.active) { drag.card = null; return; }
    var card = drag.card;
    drag.active = false; drag.card = null;
    card.style.webkitTransform = card.style.transform = '';
    card.className = card.className.replace(/\s*\blifted\b/, '');
    var box = $('accounts');
    box.className = box.className.replace(/\s*\bsorting\b/, '');
    var ids = [];
    var els = box.getElementsByClassName('card');
    for (var i = 0; i < els.length; i++) ids.push(els[i].getAttribute('data-id'));
    saveOrder(ids);
    state.sorting = false;
    if (state.data) renderAccounts();
  }
  (function bindDrag() {
    var box = $('accounts');
    var passiveFalse = false;
    try {
      // 新一點的瀏覽器要明講 passive:false，touchmove 的 preventDefault 才有效（阻止拖的時候整頁捲動）
      window.addEventListener('test', null, Object.defineProperty({}, 'passive', { get: function () { passiveFalse = { passive: false }; return true; } }));
    } catch (e) { /* 舊瀏覽器只吃布林值 */ }
    box.addEventListener('touchstart', dragStart, false);
    box.addEventListener('touchmove', dragMove, passiveFalse);
    box.addEventListener('touchend', dragEnd, false);
    box.addEventListener('touchcancel', dragEnd, false);
    box.addEventListener('mousedown', function (e) { if (e.button === 0) dragStart(e); }, false);
    document.addEventListener('mousemove', dragMove, false);
    document.addEventListener('mouseup', dragEnd, false);
    var h2 = $('usage').getElementsByTagName('h2')[0];
    if (h2) h2.innerHTML += '<span class="hint-drag">長按卡片可拖曳排序</span>';
  })();

  // ---------- 啟動 ----------
  renderClock();
  setInterval(function () {
    renderClock();
    tickResets();
  }, 1000);
  window.addEventListener('resize', function () {
    if (state.data) renderSystem(true); // 轉向只重畫，不多塞歷史點
  });
  renderConn();
  poll();
})();

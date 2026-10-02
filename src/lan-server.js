'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ============================================================
// 區網小服務：讓同一個 Wi-Fi 下的 iPad／手機用瀏覽器開儀表板。
//  - GET /            儀表板網頁（dashboard/ 資料夾裡的靜態檔）
//  - GET /api/state   目前用量＋系統指標（JSON）
//  - POST /api/order  儀表板上拖曳排序後回存卡片順序（{ ids: [...] }，只影響儀表板）
//  - 只接受私有網段來的連線（家裡區網、Tailscale），其他一律 403
//  - 回給瀏覽器的帳號資料一律經過 sanitize，永遠不含 token
// ============================================================

const DEFAULT_PORT = 3801;
const STATIC_FILES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
};
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// 只允許區網 / 本機 / Tailscale（100.64.0.0/10）來的連線
function isPrivateAddress(addr) {
  let ip = String(addr || '');
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip === '::1' || ip === '127.0.0.1') return true;
  if (/^fe80:/i.test(ip) || /^fd/i.test(ip)) return true; // IPv6 link-local / ULA
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (a === 10 || a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale / CGNAT
  if (a === 169 && b === 254) return true; // APIPA（直連時會用到）
  return false;
}

// Host 標頭只接受「localhost」或「私有網段的 IP 字面值」。
// 目的：擋 DNS rebinding——惡意網頁把自己的網域指到 192.168.x.x:3801，
// 瀏覽器就會帶著那個網域名當 Host 來讀 /api/state；只認 IP 字面值就整個擋掉。
function isAllowedHost(hostHeader) {
  let host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return false;
  if (host.startsWith('[')) {
    host = host.slice(1, host.indexOf(']')); // IPv6 字面值 [::1]:3801
  } else {
    host = host.replace(/:\d+$/, '');
  }
  if (host === 'localhost' || host === '::1') return true;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  return isPrivateAddress(host);
}

// 這台電腦可以給 iPad 輸入的網址候選（家用 192.168.* 排最前面）
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (!isPrivateAddress(info.address)) continue;
      out.push({ name, address: info.address });
    }
  }
  const rank = (a) => {
    if (a.address.startsWith('192.168.')) return 0;
    if (a.address.startsWith('10.')) return 1;
    if (a.address.startsWith('172.')) return 2;
    if (a.address.startsWith('100.')) return 3; // Tailscale：手機在外面也能看，但不是家用 Wi-Fi
    return 4;
  };
  const dedup = new Map();
  out.sort((a, b) => rank(a) - rank(b)).forEach((a) => {
    if (!dedup.has(a.address)) dedup.set(a.address, a);
  });
  return [...dedup.values()];
}

class LanServer {
  /**
   * @param {object} deps
   * @param {() => object} deps.getState   組出要給儀表板的完整狀態（呼叫端負責 sanitize）
   * @param {string} [deps.staticDir]      儀表板靜態檔資料夾
   * @param {(msg: string) => void} [deps.log]
   * @param {(ids: string[]) => void} [deps.onReorder]  儀表板拖曳排序後的新順序（帳號 id 陣列）
   */
  constructor({ getState, staticDir, log, onReorder }) {
    this.getState = getState;
    this.onReorder = onReorder || null;
    this.staticDir = staticDir || path.join(__dirname, '..', 'dashboard');
    this.log = log || (() => {});
    this.server = null;
    this.port = null;
    this.error = null;
    this.hits = 0;
    this.lastHitAt = null;
    this.lastClient = null;
    this.starting = null; // listen 進行中的 Promise；stop() 會等它結束再關，避免關到一半又被開起來
  }

  start(port = DEFAULT_PORT, host = '0.0.0.0') {
    if (this.server) return Promise.resolve({ port: this.port });
    if (this.starting) return this.starting;
    this.starting = new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this._handle(req, res));
      const onListenError = (err) => {
        this.error = err.code === 'EADDRINUSE' ? `埠號 ${port} 被別的程式占用了` : err.message;
        this.server = null;
        this.log(`區網服務啟動失敗：${this.error}`);
        reject(err);
      };
      server.once('error', onListenError);
      server.listen(port, host, () => {
        // listen 成功後換成只記錄的錯誤處理：之後的 accept 失敗之類不該把狀態清掉（埠其實還綁著）
        server.removeListener('error', onListenError);
        server.on('error', (err) => this.log(`區網服務錯誤：${err.message}`));
        this.server = server;
        this.port = server.address().port;
        this.error = null;
        this.log(`區網服務已啟動：http://${lanAddresses().map((a) => a.address).join(' / ')}:${this.port}`);
        resolve({ port: this.port });
      });
    }).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop() {
    if (this.starting) {
      try {
        await this.starting; // 正在啟動 → 等它綁好再關，不然會漏一個活著的伺服器
      } catch {
        /* 啟動失敗本來就沒東西可關 */
      }
    }
    if (!this.server) return;
    const s = this.server;
    this.server = null;
    this.port = null;
    await new Promise((resolve) => {
      s.close(() => resolve());
      if (typeof s.closeAllConnections === 'function') s.closeAllConnections();
    });
  }

  info() {
    return {
      running: Boolean(this.server),
      port: this.port,
      error: this.error,
      urls: this.server ? lanAddresses().map((a) => `http://${a.address}:${this.port}`) : [],
      hits: this.hits,
      lastHitAt: this.lastHitAt,
      lastClient: this.lastClient,
    };
  }

  _handle(req, res) {
    const remote = req.socket.remoteAddress;
    if (!isPrivateAddress(remote) || !isAllowedHost(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('只開放給區網內的裝置，且請直接用 IP 網址開啟');
      return;
    }
    const url = (req.url || '/').split('?')[0];

    if (req.method === 'POST' && url === '/api/order') {
      this._handleOrder(req, res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405);
      res.end();
      return;
    }

    if (url === '/api/state') {
      this.hits += 1;
      this.lastHitAt = Date.now();
      this.lastClient = String(remote).replace('::ffff:', '');
      let body;
      try {
        body = JSON.stringify(this.getState());
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }

    if (url === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, now: Date.now() }));
      return;
    }

    const file = STATIC_FILES[url];
    if (!file) {
      this._notFound(res);
      return;
    }
    this._serveStatic(req, res, file);
  }

  // 收儀表板送來的新順序：body 只能是小小的 JSON { ids: [字串…] }，超過 8 KB 或格式不對一律拒絕
  _handleOrder(req, res) {
    const json = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(obj));
    };
    if (!this.onReorder) {
      json(501, { ok: false, error: '這個版本不支援回存順序' });
      return;
    }
    let body = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      body += chunk;
      if (body.length > 8 * 1024) {
        tooBig = true;
        json(413, { ok: false, error: '內容太大' });
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooBig) return;
      let ids;
      try {
        ids = JSON.parse(body).ids;
      } catch {
        ids = null;
      }
      const valid = Array.isArray(ids) && ids.length <= 64 && ids.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 80);
      if (!valid) {
        json(400, { ok: false, error: '格式不對：要 { ids: [帳號 id…] }' });
        return;
      }
      try {
        this.onReorder(ids);
      } catch (err) {
        json(500, { ok: false, error: err.message });
        return;
      }
      json(200, { ok: true, ids });
    });
  }

  _notFound(res) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('沒有這個頁面');
  }

  _serveStatic(req, res, file) {
    const full = path.join(this.staticDir, file);
    fs.readFile(full, (err, data) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('儀表板檔案讀不到');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }
}

module.exports = { LanServer, isPrivateAddress, isAllowedHost, lanAddresses, DEFAULT_PORT };

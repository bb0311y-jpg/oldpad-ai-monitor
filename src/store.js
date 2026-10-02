'use strict';

const fs = require('fs');
const path = require('path');

// ============================================================
// 本地儲存：
//   accounts.json  帳號與 token（有 Windows 加密就加密存放）
//   settings.json  介面設定（非敏感，明文）
//   cache.json     最近一次抓到的用量（重開程式立刻有畫面）
//   debug/         每個帳號最近一次 API 原始回應（除錯用）
// ephemeral 模式（煙霧測試用）：全部只放記憶體、不落地。
// ============================================================

let safeStorage = null;
try {
  ({ safeStorage } = require('electron'));
} catch {
  // 在純 Node 環境（單元測試）下沒有 electron，改走明文路徑
}

class Store {
  constructor(dir, { ephemeral = false } = {}) {
    this.dir = dir;
    this.ephemeral = ephemeral;
    this.mem = { accounts: [], settings: null, cache: {} };
    if (!ephemeral) {
      fs.mkdirSync(path.join(dir, 'debug'), { recursive: true });
    }
  }

  _file(name) {
    return path.join(this.dir, name);
  }

  _canEncrypt() {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  // ---- 帳號（含 token，敏感）----
  loadAccounts() {
    if (this.ephemeral) return this.mem.accounts;
    try {
      const wrapper = JSON.parse(fs.readFileSync(this._file('accounts.json'), 'utf8'));
      if (wrapper.enc) {
        const json = safeStorage.decryptString(Buffer.from(wrapper.data, 'base64'));
        return JSON.parse(json);
      }
      return wrapper.accounts || [];
    } catch {
      return [];
    }
  }

  saveAccounts(accounts) {
    if (this.ephemeral) {
      this.mem.accounts = accounts;
      return;
    }
    let wrapper;
    if (this._canEncrypt()) {
      const encrypted = safeStorage.encryptString(JSON.stringify(accounts));
      wrapper = { v: 1, enc: true, data: encrypted.toString('base64') };
    } else {
      wrapper = { v: 1, enc: false, accounts };
    }
    fs.writeFileSync(this._file('accounts.json'), JSON.stringify(wrapper));
  }

  // ---- 設定（明文）----
  loadSettings(defaults) {
    if (this.ephemeral) return { ...defaults, ...(this.mem.settings || {}) };
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(this._file('settings.json'), 'utf8')) };
    } catch {
      return { ...defaults };
    }
  }

  saveSettings(settings) {
    if (this.ephemeral) {
      this.mem.settings = settings;
      return;
    }
    fs.writeFileSync(this._file('settings.json'), JSON.stringify(settings, null, 2));
  }

  // ---- 用量快取（明文，非敏感）----
  loadCache() {
    if (this.ephemeral) return this.mem.cache;
    try {
      return JSON.parse(fs.readFileSync(this._file('cache.json'), 'utf8'));
    } catch {
      return {};
    }
  }

  saveCache(cache) {
    if (this.ephemeral) {
      this.mem.cache = cache;
      return;
    }
    fs.writeFileSync(this._file('cache.json'), JSON.stringify(cache));
  }

  // ---- 事件紀錄：續期成功／失敗原因、需重新授權的時間點（純文字，日後排查用）----
  appendEvent(line) {
    if (this.ephemeral) return;
    try {
      const file = this._file('events.log');
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
      // 超過 512 KB 只留後半，避免無限長大
      if (fs.statSync(file).size > 512 * 1024) {
        const text = fs.readFileSync(file, 'utf8');
        fs.writeFileSync(file, text.slice(Math.floor(text.length / 2)).replace(/^[^\n]*\n/, ''));
      }
    } catch {
      // 紀錄寫不進去不影響主功能
    }
  }

  // ---- 除錯：保留最近一次原始回應 ----
  saveDebugRaw(accountId, raw) {
    if (this.ephemeral) return;
    try {
      fs.writeFileSync(
        path.join(this.dir, 'debug', `last-usage-${accountId}.json`),
        JSON.stringify(raw, null, 2)
      );
    } catch {
      // 除錯檔寫不進去不影響主功能
    }
  }
}

module.exports = { Store };

'use strict';

const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');

// ============================================================
// 系統指標：CPU／記憶體／GPU／顯存／硬碟／溫度
//  - CPU、記憶體、硬碟剩餘空間：Node 內建就讀得到
//  - 硬碟讀寫速度／忙碌％／回應時間：讀 Windows 效能計數器的「原始值」
//    （wmic Win32_PerfRawData_PerfDisk_PhysicalDisk），兩次取樣相減自己算，
//    欄位名固定不會被中文系統翻譯；wmic 不在（Win11 24H2 之後）就退回 PowerShell 的 CIM
//  - GPU：跑 nvidia-smi（沒有 NVIDIA 卡就整塊 null，不影響其他）
//  - CPU 溫度、風扇、主機板：Windows 沒有內建方法，
//    改讀 LibreHardwareMonitor 的區網資料介面（預設 http://127.0.0.1:8085/data.json）；
//    沒開就整塊 null，畫面會提示怎麼裝。
// 只有在有人（iPad）在看的時候才會持續取樣，沒人看就停，避免白白跑 nvidia-smi。
// ============================================================

const IDLE_AFTER_MS = 20 * 1000; // 多久沒人要資料就停止取樣
const SAMPLE_MS = 2000;
const DISK_CACHE_MS = 30 * 1000;
const DISK_IO_FIELDS = [
  'Name',
  'DiskReadBytesPersec',
  'DiskWriteBytesPersec',
  'DiskTransfersPersec',
  'PercentIdleTime',
  'Timestamp_Sys100NS',
  'Timestamp_PerfTime',
  'Frequency_PerfTime',
  'CurrentDiskQueueLength',
  'AvgDiskSecPerTransfer',
  'AvgDiskSecPerTransfer_Base',
];
const NVSMI_FIELDS = [
  'name',
  'temperature.gpu',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'power.draw',
  'power.limit',
  'fan.speed',
  'clocks.gr',
];

// ---- 純函式（可單元測試）----

// 兩次 os.cpus() 快照 → 每顆核心與整體的使用率 %
function cpuPercentFromSamples(prev, next) {
  if (!prev || !next || prev.length !== next.length || !next.length) return { total: null, cores: [] };
  let idleAll = 0;
  let totalAll = 0;
  const cores = next.map((c, i) => {
    const p = prev[i].times;
    const n = c.times;
    const idle = n.idle - p.idle;
    const total = ['user', 'nice', 'sys', 'idle', 'irq'].reduce((s, k) => s + (n[k] - p[k]), 0);
    idleAll += idle;
    totalAll += total;
    return total > 0 ? clampPct(100 * (1 - idle / total)) : 0;
  });
  return { total: totalAll > 0 ? clampPct(100 * (1 - idleAll / totalAll)) : null, cores };
}

function clampPct(v) {
  return Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
}

// nvidia-smi 的 csv 一列 → 物件；[N/A] 之類的值變 null。
// 顯卡名稱本身可能含逗號，所以數值欄從「尾端」固定取 8 個，前面剩下的全當名稱。
function parseNvidiaSmi(csvLine) {
  const parts = String(csvLine || '').trim().split(',').map((s) => s.trim());
  if (parts.length < NVSMI_FIELDS.length) return null;
  const num = (s) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  };
  const numeric = parts.slice(parts.length - (NVSMI_FIELDS.length - 1));
  const name = parts.slice(0, parts.length - (NVSMI_FIELDS.length - 1)).join(', ');
  const [temp, util, memUsed, memTotal, powerDraw, powerLimit, fan, clock] = numeric;
  return {
    name,
    tempC: num(temp),
    utilPct: num(util),
    vramUsedMb: num(memUsed),
    vramTotalMb: num(memTotal),
    powerW: num(powerDraw),
    powerLimitW: num(powerLimit),
    fanPct: num(fan),
    clockMhz: num(clock),
  };
}

// LibreHardwareMonitor 的 data.json 是一棵樹：{ Text, Value, ImageURL, Children[] }
// 感測器種類看不到欄位，只能從 ImageURL 的圖檔名判斷。
function lhmSensorType(node) {
  const img = String(node.ImageURL || '');
  if (/temperature/i.test(img)) return 'temp';
  if (/load/i.test(img)) return 'load';
  if (/fan/i.test(img)) return 'fan';
  if (/power/i.test(img)) return 'power';
  if (/clock/i.test(img)) return 'clock';
  if (/voltage/i.test(img)) return 'voltage';
  return null;
}

function lhmHardwareKind(node) {
  const img = String(node.ImageURL || '');
  if (/cpu/i.test(img)) return 'cpu';
  if (/nvidia|ati|amd|gpu|intel/i.test(img) && !/cpu/i.test(img)) return 'gpu';
  if (/mainboard|chip/i.test(img)) return 'board';
  if (/hdd|ssd|nvme|drive/i.test(img)) return 'disk';
  if (/ram/i.test(img)) return 'ram';
  return 'other';
}

function lhmValue(s) {
  // "1,204 RPM" 的逗號是千分位、"38,5 °C" 的逗號是歐洲小數點，分開處理
  const v = parseFloat(String(s || '').replace(/,(?=\d{3}(?!\d))/g, '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
}

// 硬碟型號縮短：去掉廠牌前綴與型號尾巴，例如「WDC PC SN530 SDBPNPZ-1T00-1032」→「SN530」
function shortDiskName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  const skip = /^(WDC|WD|Samsung|Seagate|Crucial|Kingston|Intel|SK|hynix|Toshiba|Micron|ADATA|XPG|PC|SSD|NVMe|Series)$/i;
  const body = words.filter((w) => !skip.test(w) && !/^[A-Z0-9-]{10,}$/.test(w));
  const out = (body.length ? body : words).slice(0, 2).join(' ');
  return out.length > 15 ? out.slice(0, 15) : out || '硬碟';
}

// 整棵樹 → 扁平感測器清單 ＋ 幾個常用的摘要值
function parseLhm(tree) {
  const sensors = [];
  // 真實資料：硬體節點帶 cpu.png 之類的圖；感測器「群組」節點帶 temperature.png；
  // 葉子（真正的數值）圖是 transparent.png，所以種類要從上一層群組繼承。
  const walk = (node, hw, hwKind, groupType) => {
    if (!node) return;
    const isLeaf = !(node.Children && node.Children.length);
    const ownType = lhmSensorType(node);
    if (isLeaf) {
      const type = ownType || groupType;
      if (type && node.Value !== undefined && node.Value !== '') {
        sensors.push({ hw, hwKind, name: node.Text, type, value: lhmValue(node.Value) });
      }
      return;
    }
    if (ownType) {
      (node.Children || []).forEach((c) => walk(c, hw, hwKind, ownType));
      return;
    }
    const kind = hwKind || (node.ImageURL && !/computer/i.test(node.ImageURL) ? lhmHardwareKind(node) : null);
    const hwName = hw || (kind ? node.Text : null);
    (node.Children || []).forEach((c) => walk(c, hwName, kind, null));
  };
  walk(tree, null, null, null);

  const temps = sensors.filter((s) => s.type === 'temp' && s.value !== null);
  const cpuTemps = temps.filter((s) => s.hwKind === 'cpu');
  const pick = (list, patterns) => {
    for (const re of patterns) {
      const hit = list.find((s) => re.test(s.name));
      if (hit) return hit.value;
    }
    return list.length ? list[0].value : null;
  };
  // 每顆硬碟只留第一個溫度感測器（NVMe 常回 3 個，其餘是內部感測點）
  const diskTemps = [];
  const seenDisk = new Set();
  for (const s of temps) {
    if (s.hwKind !== 'disk' || seenDisk.has(s.hw)) continue;
    seenDisk.add(s.hw);
    diskTemps.push({ name: shortDiskName(s.hw), tempC: s.value });
  }
  const boardTemps = temps
    .filter((s) => s.hwKind === 'board')
    .map((s) => ({ name: s.name, tempC: s.value }));
  return {
    cpuTempC: pick(cpuTemps, [/package/i, /tctl|tdie/i, /core max/i, /average/i, /core/i]),
    boardTempC: pick(temps.filter((s) => s.hwKind === 'board'), [/^system$|motherboard|mainboard/i]),
    boardTemps,
    diskTemps,
    fans: sensors
      .filter((s) => s.type === 'fan' && s.value !== null && s.value > 0) // 沒接或停轉的風扇不列
      .map((s) => ({ hw: s.hw, name: s.name, rpm: Math.round(s.value) })),
    sensors,
  };
}

// ---- 硬碟讀寫（原始效能計數器 → 人看得懂的數字）----

// 簡易 CSV：wmic /format:csv（無引號、CRLF、前面有空行）與 PowerShell ConvertTo-Csv（有引號）都吃
function parseCsv(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const split = (line) => {
    const out = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
      } else if (ch === ',' && !q) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const header = split(lines[0]);
  return lines.slice(1).map((l) => {
    const cells = split(l);
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] === undefined ? '' : cells[i]; });
    return row;
  });
}

// 效能計數器的實體名「0 D: E: F:」→ { index: 0, letters: ['D:', 'E:', 'F:'] }；「_Total」→ null
function parseDiskInstance(name) {
  const m = /^(\d+)((?:\s+[A-Z]:)*)\s*$/i.exec(String(name || '').trim());
  if (!m) return null;
  return { index: Number(m[1]), letters: (m[2].match(/[A-Z]:/gi) || []).map((l) => l.toUpperCase()) };
}

// 一次 wmic 取樣 → 以實體碟編號為 key 的原始值（數字化）
// 欄名比對不分大小寫：WMI 真正的名字是 AvgDisksecPerTransfer（sec 小寫），wmic 輸出照它的寫法
function diskRawByIndex(rows) {
  const out = {};
  for (const r of rows) {
    const lower = {};
    for (const k of Object.keys(r)) lower[k.toLowerCase()] = r[k];
    const inst = parseDiskInstance(lower.name);
    if (!inst) continue;
    const raw = { index: inst.index, letters: inst.letters };
    for (const f of DISK_IO_FIELDS) {
      if (f === 'Name') continue;
      const v = Number(lower[f.toLowerCase()]);
      raw[f] = Number.isFinite(v) ? v : 0;
    }
    out[inst.index] = raw;
  }
  return out;
}

// 兩次原始值相減 → 每顆實體碟的讀寫速度（bytes/s）、忙碌％、每次存取平均回應（ms）、目前排隊件數
// 公式照微軟計數器型別：
//   bytes/s、次/s = ΔN ÷ (ΔTimestamp_PerfTime ÷ Frequency_PerfTime)
//   閒置％       = ΔPercentIdleTime ÷ ΔTimestamp_Sys100NS（都是 100ns 單位）→ 忙碌＝100−閒置
//   回應秒       = (ΔAvgDiskSecPerTransfer ÷ Frequency) ÷ ΔBase
function diskIoFromRaw(prev, next) {
  const out = [];
  if (!prev || !next) return out;
  for (const key of Object.keys(next)) {
    const n = next[key];
    const p = prev[key];
    if (!p) continue;
    const freq = n.Frequency_PerfTime || 10000000;
    const dt = (n.Timestamp_PerfTime - p.Timestamp_PerfTime) / freq;
    const dt100 = n.Timestamp_Sys100NS - p.Timestamp_Sys100NS;
    if (!(dt > 0) || !(dt100 > 0)) continue;
    const rate = (f) => Math.max(0, (n[f] - p[f]) / dt);
    const idle = (n.PercentIdleTime - p.PercentIdleTime) / dt100;
    const dBase = n.AvgDiskSecPerTransfer_Base - p.AvgDiskSecPerTransfer_Base;
    const respMs = dBase > 0 ? Math.max(0, ((n.AvgDiskSecPerTransfer - p.AvgDiskSecPerTransfer) / freq / dBase) * 1000) : 0;
    out.push({
      index: n.index,
      letters: n.letters,
      readBps: Math.round(rate('DiskReadBytesPersec')),
      writeBps: Math.round(rate('DiskWriteBytesPersec')),
      iops: Math.round(rate('DiskTransfersPersec')),
      busyPct: clampPct(100 * (1 - idle)),
      respMs: Math.round(respMs * 100) / 100,
      queue: n.CurrentDiskQueueLength,
    });
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---- 取樣器 ----

class SystemMetrics {
  constructor({ lhmUrl = 'http://127.0.0.1:8085/data.json', nvidiaSmi = 'nvidia-smi' } = {}) {
    this.lhmUrl = lhmUrl;
    this.nvidiaSmi = nvidiaSmi;
    this.timer = null;
    this.lastTouch = 0;
    this.prevCpus = null;
    this.diskCache = { at: 0, disks: [] };
    this.nvsmiMissing = false;
    this.ticking = false; // 重入鎖：上一輪還沒跑完就不開下一輪（nvidia-smi 慢時不會堆一排子行程）
    this.fixedDrives = { at: 0, list: null };
    this.diskModels = { at: 0, map: null }; // 實體碟編號 → { model, fixed }
    this.prevDiskRaw = null;
    this.diskIoTool = null; // null=還沒試、'wmic'、'cim'（PowerShell 備援）、false=都不行
    this.latest = {
      sampledAt: null,
      cpu: { pct: null, cores: [], count: os.cpus().length, model: (os.cpus()[0] || {}).model || '' },
      mem: this._mem(),
      gpu: null,
      gpus: [],
      gpuAvailable: null, // null = 還沒試過，false = 沒 nvidia-smi
      lhm: null,
      lhmAvailable: null,
      disks: [],
      diskIo: [], // 每顆實體碟的讀寫速度／忙碌／回應（第二次取樣起才有）
      diskIoAvailable: null,
      uptimeSec: Math.round(os.uptime()),
      host: os.hostname(),
    };
  }

  // 有人要資料 → 確保取樣器在跑
  touch() {
    this.lastTouch = Date.now();
    if (!this.timer) {
      this.prevCpus = os.cpus();
      this.timer = setInterval(() => this._tick(), SAMPLE_MS);
      this._tick();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.prevCpus = null;
    this.prevDiskRaw = null; // 停久了再開，第一筆差分不能拿舊快照算（會攤成極小的平均）
  }

  snapshot() {
    this.touch();
    return this.latest;
  }

  _mem() {
    const total = os.totalmem();
    const free = os.freemem();
    return { totalBytes: total, usedBytes: total - free, pct: clampPct((100 * (total - free)) / total) };
  }

  async _tick() {
    if (Date.now() - this.lastTouch > IDLE_AFTER_MS) {
      this.stop();
      return;
    }
    if (this.ticking) return;
    this.ticking = true;
    try {
      const cpus = os.cpus();
      const cpu = cpuPercentFromSamples(this.prevCpus, cpus);
      this.prevCpus = cpus;
      const [gpus, lhm, disks, diskIo] = await Promise.all([this._gpu(), this._lhm(), this._disks(), this._diskIo()]);
      this.latest = {
        sampledAt: Date.now(),
        cpu: { pct: cpu.total, cores: cpu.cores, count: cpus.length, model: (cpus[0] || {}).model || '' },
        mem: this._mem(),
        gpu: gpus[0] || null,
        gpus,
        gpuAvailable: !this.nvsmiMissing,
        lhm,
        lhmAvailable: lhm !== null,
        disks,
        diskIo,
        diskIoAvailable: this.diskIoTool !== false,
        uptimeSec: Math.round(os.uptime()),
        host: os.hostname(),
      };
    } finally {
      this.ticking = false;
    }
  }

  // 回傳所有 NVIDIA 卡（沒有就空陣列）
  _gpu() {
    if (this.nvsmiMissing) return Promise.resolve([]);
    return new Promise((resolve) => {
      execFile(
        this.nvidiaSmi,
        [`--query-gpu=${NVSMI_FIELDS.join(',')}`, '--format=csv,noheader,nounits'],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => {
          if (err) {
            if (err.code === 'ENOENT') this.nvsmiMissing = true;
            resolve([]);
            return;
          }
          resolve(
            String(stdout)
              .split('\n')
              .map((l) => l.trim())
              .filter(Boolean)
              .map(parseNvidiaSmi)
              .filter(Boolean)
          );
        }
      );
    });
  }

  _lhm() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => {
        if (!done) {
          done = true;
          resolve(v);
        }
      };
      // 硬保險：對方回了 header 卻不給 body 時 destroy 不會觸發 error，這裡 2 秒一律收工
      const guard = setTimeout(() => {
        finish(null);
        req.destroy();
      }, 2000);
      const req = http.get(this.lhmUrl, { timeout: 1500 }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('aborted', () => finish(null));
        res.on('close', () => finish(null));
        res.on('end', () => {
          try {
            finish(parseLhm(JSON.parse(body)));
          } catch {
            finish(null);
          }
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => finish(null));
      req.on('close', () => {
        clearTimeout(guard);
        finish(null);
      });
    });
  }

  // 固定硬碟清單（排除網路磁碟、光碟、隨身碟），5 分鐘問一次 wmic；問不到就只看 C:
  _fixedDrives() {
    if (this.fixedDrives.list && Date.now() - this.fixedDrives.at < 5 * 60 * 1000) {
      return Promise.resolve(this.fixedDrives.list);
    }
    return new Promise((resolve) => {
      execFile(
        'wmic',
        ['logicaldisk', 'where', 'drivetype=3', 'get', 'deviceid'],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => {
          let list = err ? null : String(stdout).match(/[A-Z]:/g);
          if (!list || !list.length) list = ['C:'];
          this.fixedDrives = { at: Date.now(), list };
          resolve(list);
        }
      );
    });
  }

  async _disks() {
    if (Date.now() - this.diskCache.at < DISK_CACHE_MS) return this.diskCache.disks;
    this.diskCache.at = Date.now(); // 先蓋時間戳：慢的磁碟不會每 2 秒被重問
    const disks = [];
    for (const drive of await this._fixedDrives()) {
      const root = `${drive}\\`;
      try {
        const st = await fs.promises.statfs(root); // 全程非同步，不用 existsSync 擋主執行緒
        const total = st.blocks * st.bsize;
        if (!total) continue;
        const free = st.bavail * st.bsize;
        disks.push({ drive, totalBytes: total, usedBytes: total - free, pct: clampPct((100 * (total - free)) / total) });
      } catch {
        /* 沒權限或磁碟暫時不在就跳過 */
      }
    }
    this.diskCache = { at: Date.now(), disks };
    return disks;
  }

  // 實體碟的型號與是否固定碟（排除 USB 讀卡機／隨身碟），5 分鐘問一次
  _diskModels() {
    if (this.diskModels.map && Date.now() - this.diskModels.at < 5 * 60 * 1000) {
      return Promise.resolve(this.diskModels.map);
    }
    return new Promise((resolve) => {
      execFile(
        'wmic',
        ['diskdrive', 'get', 'Index,Model,MediaType', '/format:csv'],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => {
          const map = {};
          if (!err) {
            for (const r of parseCsv(stdout)) {
              const idx = Number(r.Index);
              if (!Number.isFinite(idx)) continue;
              map[idx] = { model: r.Model || '', fixed: /fixed/i.test(r.MediaType || '') };
            }
          }
          this.diskModels = { at: Date.now(), map: Object.keys(map).length ? map : null };
          resolve(this.diskModels.map);
        }
      );
    });
  }

  // 原始效能計數器一次取樣（wmic 優先；沒有 wmic 就用 PowerShell CIM，慢一點但欄位一樣）
  _diskRawSample() {
    if (this.diskIoTool === false) return Promise.resolve(null);
    const fields = DISK_IO_FIELDS.join(',');
    const viaCim = () =>
      new Promise((resolve) => {
        execFile(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-Command',
            `Get-CimInstance Win32_PerfRawData_PerfDisk_PhysicalDisk | Select-Object ${fields} | ConvertTo-Csv -NoTypeInformation`],
          { timeout: 6000, windowsHide: true },
          (err, stdout) => {
            if (err) { this.diskIoTool = false; resolve(null); return; }
            this.diskIoTool = 'cim';
            resolve(diskRawByIndex(parseCsv(stdout)));
          }
        );
      });
    if (this.diskIoTool === 'cim') return viaCim();
    return new Promise((resolve) => {
      execFile(
        'wmic',
        ['path', 'Win32_PerfRawData_PerfDisk_PhysicalDisk', 'get', fields, '/format:csv'],
        { timeout: 4000, windowsHide: true },
        (err, stdout) => {
          if (err) { resolve(viaCim()); return; }
          this.diskIoTool = 'wmic';
          resolve(diskRawByIndex(parseCsv(stdout)));
        }
      );
    });
  }

  // 這一輪取樣壞掉（wmic 逾時、輸出不完整）時沿用上一筆好的，最多撐這麼久；
  // 否則 iPad 畫面會在「讀寫速度」和舊的「容量」版面之間跳來跳去
  static get DISK_IO_STICKY_MS() { return 30 * 1000; }

  _lastGoodDiskIo() {
    const last = this.lastDiskIo;
    if (last && Date.now() - last.at < SystemMetrics.DISK_IO_STICKY_MS) return last.list;
    return [];
  }

  async _diskIo() {
    const [raw, models] = await Promise.all([this._diskRawSample(), this._diskModels()]);
    const count = raw ? Object.keys(raw).length : 0;
    const prevCount = this.prevDiskRaw ? Object.keys(this.prevDiskRaw).length : 0;
    // 沒資料、或這次看到的硬碟比上次少（wmic 偶爾吐一半）→ 當作壞樣本：不更新基準、沿用上一筆
    if (!count || count < prevCount) return this._lastGoodDiskIo();
    const io = diskIoFromRaw(this.prevDiskRaw, raw);
    this.prevDiskRaw = raw;
    if (!io.length) return this._lastGoodDiskIo(); // 第一筆只有基準，還算不出速度
    const list = io
      .filter((d) => (models && models[d.index] ? models[d.index].fixed : d.letters.length > 0)) // 沒型號表就至少要有槽號
      .map((d) => {
        const m = models && models[d.index];
        return { ...d, model: m ? m.model : '', name: m ? shortDiskName(m.model) : '' };
      });
    if (list.length) this.lastDiskIo = { at: Date.now(), list };
    return list.length ? list : this._lastGoodDiskIo();
  }
}

module.exports = {
  SystemMetrics,
  cpuPercentFromSamples,
  parseNvidiaSmi,
  parseLhm,
  shortDiskName,
  parseCsv,
  parseDiskInstance,
  diskRawByIndex,
  diskIoFromRaw,
};

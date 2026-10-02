'use strict';

const zlib = require('zlib');

// ============================================================
// 程式自己畫出圖示（環形儀表），不需要外部圖片檔。
// 輸出標準 PNG buffer，給系統列（tray）與視窗圖示用。
// ============================================================

// ---- 迷你 PNG 編碼器（RGBA、無壓縮濾波）----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}

function rgbaToPng(rgba, width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 畫一個 270° 的環形儀表 ----
function lerp(a, b, t) {
  return a + (b - a) * t;
}

function gaugePng(size = 32) {
  const rgba = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const outer = size * 0.46;
  const inner = size * 0.27;
  // 儀表從左下 135° 順時針掃 270° 到右下 45°
  const startDeg = 135;
  const sweepDeg = 270;
  const litRatio = 0.72; // 亮起的比例（純裝飾）
  // 色彩：橘（Claude 主色）漸層到洋紅
  const c1 = [0xd9, 0x77, 0x57];
  const c2 = [0xe0, 0x45, 0x7b];
  const dim = [0x4a, 0x4f, 0x5c];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      // 環的邊緣做 1px 漸淡（抗鋸齒）
      const edge = Math.min(dist - inner, outer - dist);
      if (edge <= -1) continue;
      let alpha = Math.max(0, Math.min(1, edge + 0.5));
      if (alpha <= 0) continue;

      let angle = (Math.atan2(dy, dx) * 180) / Math.PI; // -180..180，0 = 右
      let rel = (angle - startDeg + 720) % 360;
      if (rel > sweepDeg) {
        // 缺口（下方 90°）不畫
        const overflow = Math.min(rel - sweepDeg, 360 - rel);
        if (overflow > 4) continue;
        alpha *= Math.max(0, 1 - overflow / 4);
        rel = rel > 350 ? 0 : sweepDeg;
      }
      const t = rel / sweepDeg;
      const lit = t <= litRatio;
      const color = lit
        ? [lerp(c1[0], c2[0], t / litRatio), lerp(c1[1], c2[1], t / litRatio), lerp(c1[2], c2[2], t / litRatio)]
        : dim;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(color[0]);
      rgba[i + 1] = Math.round(color[1]);
      rgba[i + 2] = Math.round(color[2]);
      rgba[i + 3] = Math.round(alpha * 255);
    }
  }
  return rgbaToPng(rgba, size, size);
}

module.exports = { gaugePng, rgbaToPng };

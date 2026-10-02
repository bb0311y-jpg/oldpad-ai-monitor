'use strict';

// 打包前產生 build/icon.ico（EXE 與安裝檔的圖示）。
// 直接用程式裡同一個環形儀表繪圖器，各尺寸打包成標準 ICO 容器。

const fs = require('fs');
const path = require('path');
const { gaugePng } = require('../src/icon');

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const pngs = SIZES.map((s) => gaugePng(s));

// ICO 結構：檔頭(6) + 目錄項(每個 16 bytes) + 各圖檔內容（PNG 格式）
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(SIZES.length, 4);

let offset = 6 + 16 * SIZES.length;
const entries = [];
SIZES.forEach((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s; // 寬（256 記為 0）
  e[1] = s === 256 ? 0 : s; // 高
  e[2] = 0; // 色盤數
  e[3] = 0; // reserved
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bpp
  e.writeUInt32LE(pngs[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += pngs[i].length;
  entries.push(e);
});

const ico = Buffer.concat([header, ...entries, ...pngs]);
const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log(`build/icon.ico 產生完成（${ico.length} bytes，${SIZES.length} 種尺寸）`);

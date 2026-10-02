'use strict';

/* ============================================================
   版面計算（純函式，瀏覽器與 Node 都能用）

   視窗可以被使用者任意拉大縮小，這裡負責決定：
   - cols：要排幾欄
   - tier：密度層級 normal（完整）/ tight（緊湊）/ compact（精簡）
   - zoom：整片內容的等比縮放倍率
   - height：自動高度模式下，視窗內容區該有的高度（螢幕 px）

   規則白話版：
   1. 視窗變窄 → 內容先等比縮小；窄到每欄不到某個寬度就降一級密度
      （藏掉次要文字、縮小間距），讓字不會小到看不見。
   2. 視窗變寬 → 固定欄數時內容等比放大（有上限）；自動欄數時改成多排幾欄。
   3. 高度被手動拉短 → 先降密度，再等比縮小，真的還放不下才捲動。
   ============================================================ */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Layout = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const GAP = 8; // 欄與欄之間的間距（zoom=1 時的 css px）
  const BODY_PAD = 24; // body 上下左右各 12px，留給陰影
  const PANEL_MIN_H = 430; // 授權／設定面板打開時的最小內容高度（zoom=1）

  // 各密度層級在 zoom = 1 時，每一欄的設計寬度
  // （對齊 main.js WIDTHS 的預設視窗寬：雙欄 728 → (728-24-8)/2 = 348；精簡 576 → 272）
  const DESIGN_COL_W = { normal: 348, tight: 300, compact: 272 };
  // 實際每欄寬度（螢幕 px）低於這個值就降一級密度
  const TIER_MIN_COL_W = { normal: 320, tight: 260 };
  const ZOOM_MIN = 0.6;
  const ZOOM_MAX = 1.75; // 固定欄數時允許放大的上限
  const ZOOM_MAX_AUTO = 1; // 自動欄數：變寬時多排欄而不是放大字
  const MAX_AUTO_COLS = 4;
  // 高度放不下時，縮到比這個倍率還小之前，先降一級密度
  const DENSIFY_BELOW = 0.8;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const denser = (tier) => (tier === 'normal' ? 'tight' : 'compact');

  function designWidth(tier, cols) {
    return DESIGN_COL_W[tier] * cols + GAP * (cols - 1);
  }

  function pickColumns(columnsSetting, availW, tierForAuto) {
    const fixed = Number(columnsSetting);
    if (fixed >= 1) return clamp(Math.floor(fixed), 1, 6);
    const unit = DESIGN_COL_W[tierForAuto] + GAP;
    return clamp(Math.floor((availW + GAP) / unit), 1, MAX_AUTO_COLS);
  }

  function tierForColumnWidth(colW) {
    if (colW >= TIER_MIN_COL_W.normal) return 'normal';
    if (colW >= TIER_MIN_COL_W.tight) return 'tight';
    return 'compact';
  }

  /**
   * @param {object} o
   * @param {number} o.innerW  視窗內容區寬（螢幕 px）
   * @param {number} o.innerH  視窗內容區高（螢幕 px）
   * @param {number|string} o.columnsSetting  0/'auto' = 自動；1、2、3… = 固定欄數
   * @param {boolean} o.forceCompact  使用者按了精簡模式
   * @param {boolean} o.autoHeight  視窗高度是否自動貼合內容
   * @param {boolean} o.panelOpen  授權／設定面板是否開著
   * @param {(tier:string, cols:number, zoom:number) => number} o.measure
   *        套用該層級／欄數／縮放後，量出內容的自然高度（zoom=1 的 css px）
   */
  function computeLayout(o) {
    const availW = Math.max(60, (o.innerW || 0) - BODY_PAD);
    const availH = Math.max(60, (o.innerH || 0) - BODY_PAD);
    const autoCols = !(Number(o.columnsSetting) >= 1);
    const zoomMax = autoCols ? ZOOM_MAX_AUTO : ZOOM_MAX;

    const baseTier = o.forceCompact ? 'compact' : 'normal';
    const cols = pickColumns(o.columnsSetting, availW, baseTier);
    const colW = (availW - GAP * (cols - 1)) / cols;
    let tier = o.forceCompact ? 'compact' : tierForColumnWidth(colW);

    let zoom = 1;
    let natural = 0;
    for (let i = 0; i < 3; i++) {
      zoom = clamp(availW / designWidth(tier, cols), ZOOM_MIN, zoomMax);
      natural = o.measure ? o.measure(tier, cols, zoom) : 0;
      if (o.autoHeight || !natural) break;

      // 高度是使用者定的：放不下就先降密度，再等比縮小
      const zoomH = availH / natural;
      if (zoomH >= zoom) break;
      if (zoomH < DENSIFY_BELOW && tier !== 'compact') {
        tier = denser(tier);
        continue;
      }
      zoom = Math.max(ZOOM_MIN, zoomH);
      break;
    }

    let height = null;
    if (o.autoHeight) {
      let contentH = natural;
      if (o.panelOpen) contentH = Math.max(contentH, PANEL_MIN_H);
      height = Math.ceil(contentH * zoom + BODY_PAD + 1);
    }

    return { cols, tier, zoom: Math.round(zoom * 1000) / 1000, height, availW, availH };
  }

  return {
    computeLayout,
    pickColumns,
    tierForColumnWidth,
    designWidth,
    GAP,
    BODY_PAD,
    DESIGN_COL_W,
    TIER_MIN_COL_W,
    ZOOM_MIN,
    ZOOM_MAX,
  };
});

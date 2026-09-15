/* 推荐框的样子(v1.23):颜色 / 画到第几名 / 粗细 都可以在设置面板里改, 存 settings.json 的 look 字段。
   覆盖层(overlay.html)和设置面板的预览(settings.html)画的是同一份代码 —— 预览里看到什么, 游戏里就是什么。
   默认配色是朋友 09-15 改的那套(截图取色):第一名红、第二名黄、第三名紫、4~8 名浅蓝。
   画法不变:游戏画面本身很鲜艳, 每条亮边外面都套一圈黑边, 靠明暗对比而不是颜色取胜。 */
(function (g) {
  "use strict";
  const DEF = { c1: "#ff4d4f", c2: "#ffd038", c3: "#c263ff", mid: "#80d5fb", rest: "#c9d1d9", midN: 8, thick: 1, showRest: true };
  const HEX = /^#[0-9a-fA-F]{6}$/;
  /* 任何来路的配置都先过这一遍:缺的补默认, 错的丢掉, 范围夹住 —— settings.json 被手改坏了也不至于画不出来 */
  function norm(o) {
    const r = Object.assign({}, DEF); if (!o || typeof o !== "object") return r;
    for (const k of ["c1", "c2", "c3", "mid", "rest"]) if (typeof o[k] === "string" && HEX.test(o[k])) r[k] = o[k].toLowerCase();
    if (Number.isFinite(+o.midN)) r.midN = Math.min(10, Math.max(3, Math.round(+o.midN)));
    if (Number.isFinite(+o.thick)) r.thick = Math.min(2, Math.max(0.5, Math.round(+o.thick * 10) / 10));
    if (typeof o.showRest === "boolean") r.showRest = o.showRest;
    return r;
  }
  function bar(ctx, x, y, w, h, txt, col, fs, alpha) {
    ctx.globalAlpha = alpha; ctx.fillStyle = "#000"; ctx.fillRect(x, y + h - fs - 8, w, fs + 8);
    ctx.globalAlpha = 1; ctx.fillStyle = col; ctx.font = `bold ${fs}px "Segoe UI",system-ui`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(txt, x + w / 2, y + h - 4 - fs / 2);
  }
  function badge(ctx, x, y, r, n, col) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = "#000"; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = col; ctx.stroke(); ctx.fillStyle = col; ctx.font = `bold ${Math.round(r * 1.35)}px "Segoe UI",system-ui`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(n), x, y + 1);
  }
  /* 画第 i 名(0 起)的框 + 底部胜率条 + 名次徽章。box 已换算成覆盖窗坐标;dashed = 预估(还没轮到)画虚线。
     前三 = 粗框(外黑 + 亮色 + 外发光, 第一名更粗更亮) + 大徽章;4~midN = 中框 + 小徽章;之后只写胜率(可关)。 */
  function drawRow(ctx, i, x, y, w, h, txt, look, dashed) {
    const L = look || DEF, t = L.thick;
    if (i < 3) {
      const col = [L.c1, L.c2, L.c3][i], lw = Math.max(2, Math.round([9, 6, 6][i] * t)), off = lw / 2, glow = Math.round([30, 18, 18][i] * t);
      ctx.save(); ctx.shadowColor = col; ctx.shadowBlur = glow;
      ctx.lineWidth = lw + 4; ctx.strokeStyle = "#000"; ctx.strokeRect(x - off - 2, y - off - 2, w + 2 * off + 4, h + 2 * off + 4);
      if (dashed) ctx.setLineDash([10, 6]); ctx.lineWidth = lw; ctx.strokeStyle = col; ctx.strokeRect(x - off, y - off, w + 2 * off, h + 2 * off); ctx.setLineDash([]); ctx.restore();
      bar(ctx, x, y, w, h, txt, col, 15, 0.85); badge(ctx, x + 2, y + 2, 14, i + 1, col);
    } else if (i < L.midN) {
      const lw = Math.max(1, Math.round(3 * t)), off = lw / 2;
      ctx.lineWidth = lw + 3; ctx.strokeStyle = "#000"; ctx.strokeRect(x - off - 1.5, y - off - 1.5, w + 2 * off + 3, h + 2 * off + 3);
      ctx.lineWidth = lw; ctx.strokeStyle = L.mid; ctx.strokeRect(x - off, y - off, w + 2 * off, h + 2 * off);
      bar(ctx, x, y, w, h, txt, L.mid, 13, 0.8); badge(ctx, x + 1, y + 1, 10, i + 1, L.mid);
    } else if (L.showRest) bar(ctx, x, y, w, h, txt, L.rest, 11, 0.6);
  }
  const X = { DEF, norm, drawRow, bar, badge };
  g.ADFrames = X; if (typeof module !== "undefined" && module.exports) module.exports = X;
})(typeof window !== "undefined" ? window : globalThis);

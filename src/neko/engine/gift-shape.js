// @ts-nocheck
/**
 * 선물 모양: 모델이 적은 도형 목록(데이터)을 검사하고, 네코와 같은 그림체로 그린다. 설계: docs/neko-gifts.md §2.
 *
 * 모델은 모양만 정하고 그림체는 여기서 입힌다 — 선 없는 면에 위는 밝고 아래는 살짝 어두운 입체, 옅은 가장자리
 * 그림자, 팔레트 색. 그래야 어떤 모양이 와도 네코·소품(상자·그릇)과 어울린다. 모양은 데이터일 뿐이라 eval 하지
 * 않고, 이상한 값은 잘라 내거나 버린다.
 *
 * 알아보게 하는 건 모양의 몫이다: 정확한 실루엣(poly 는 round 0 이면 뾰족), 특징을 긋는 line(잎맥·꼭지·주름),
 * 같은 색의 .dark·.light 로 그늘과 무늬.
 *
 * 좌표: 32×32 칸, 가운데 x = 0, 바닥 y = 0(위가 음수). 그릴 때 unit(px/칸)을 곱한다.
 */

/** 팔레트 이름 → 실제 색. 소품과 같은 채도·밝기로 맞춰 둔다. 이름 뒤에 .dark·.light 를 붙이면 같은 색의 그늘·밝은 쪽 */
export const GIFT_PALETTE = {
  red: "#e46a5e", orange: "#f0a04b", yellow: "#f5cf55", green: "#7fbf6a", teal: "#5fc0b0", blue: "#6fa8e0",
  purple: "#a98ad8", pink: "#f2a7b8", brown: "#b07a4a", gray: "#a7a39c", white: "#f4f1ea", black: "#3a3634",
  gold: "#e8b93e", silver: "#c9cdd2",
};
/** 모델에게 보여 줄 색 이름 전부(툴 스키마의 enum) */
export const GIFT_COLORS = Object.keys(GIFT_PALETTE).flatMap((c) => [c, `${c}.dark`, `${c}.light`]);
const KINDS = new Set(["circle", "ellipse", "rrect", "poly", "line", "dot"]);
const MAX_PARTS = 24;
const HALF = 16;

const num = (v, lo, hi, dflt) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
// 자기 칸만 본다: "constructor"·"toString" 같은 이름이 프로토타입을 타고 통과하면 그릴 때 예외가 나고,
// 그 모양이 선물함에 저장돼 켤 때마다 엔진이 멈췄다
function color(c) {
  if (typeof c !== "string") return "gray";
  const [base, tone, extra] = c.split(".");
  if (extra !== undefined || !Object.hasOwn(GIFT_PALETTE, base)) return "gray";
  return tone === "dark" || tone === "light" ? `${base}.${tone}` : base;
}
const point = (q) => [num(q[0], -HALF, HALF, 0), num(q[1], -2 * HALF, 0, 0)];
const points = (pts, max) => (Array.isArray(pts) ? pts.filter((q) => Array.isArray(q) && q.length >= 2).slice(0, max).map(point) : []);

/** 동글동글한 조약돌. 모양이 다 망가졌을 때 대신 쓴다. */
export const DEFAULT_SHAPE = Object.freeze({
  v: 1,
  parts: [
    { t: "ellipse", x: 0, y: -6, rx: 9, ry: 6, rot: 0, c: "gray" },
    { t: "ellipse", x: 2.5, y: -4, rx: 3, ry: 1.4, rot: 0.3, c: "gray.dark" },
    { t: "dot", x: -3, y: -9, r: 1.2, c: "white" },
  ],
});

/** 받은 모양을 그릴 수 있는 꼴로 바꾼다. 쓸 만한 도형이 없으면 DEFAULT_SHAPE. */
export function validateShape(raw) {
  const list = raw && Array.isArray(raw.parts) ? raw.parts : [];
  const parts = [];
  for (const p of list) {
    if (parts.length >= MAX_PARTS) break;
    if (!p || typeof p !== "object" || !KINDS.has(p.t)) continue;
    const x = num(p.x, -HALF, HALF, 0), y = num(p.y, -2 * HALF, 0, -HALF), c = color(p.c);
    if (p.t === "circle") parts.push({ t: "circle", x, y, r: num(p.r, 0.8, HALF, 4), c });
    else if (p.t === "ellipse") parts.push({ t: "ellipse", x, y, rx: num(p.rx, 0.8, HALF, 4), ry: num(p.ry, 0.8, HALF, 4), rot: num(p.rot, -Math.PI, Math.PI, 0), c });
    else if (p.t === "rrect") parts.push({ t: "rrect", x, y, w: num(p.w, 1, 2 * HALF, 8), h: num(p.h, 1, 2 * HALF, 8), rad: num(p.rad, 0, HALF, 2), rot: num(p.rot, -Math.PI, Math.PI, 0), c });
    else if (p.t === "dot") parts.push({ t: "dot", x, y, r: num(p.r, 0.3, 2, 1.2), c }); // 반짝임은 크게, 결·알갱이는 작게
    else if (p.t === "poly") {
      const pts = points(p.pts, 24);
      if (pts.length >= 3) parts.push({ t: "poly", pts, round: num(p.round, 0, 6, 1.2), c });
    } else if (p.t === "line") {
      const pts = points(p.pts, 12);
      if (pts.length >= 2) parts.push({ t: "line", pts, w: num(p.w, 0.3, 4, 0.8), c });
    }
  }
  // 너무 작아 안 보이면(다 점·선뿐) 조약돌로
  const big = parts.some((p) => p.t !== "dot" && p.t !== "line");
  return big ? { v: 1, parts } : DEFAULT_SHAPE;
}

/** 한 도형의 칸 [x0, y0, x1, y1](바닥 기준 좌표) */
function partBox(p) {
  if (p.t === "circle") return [p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r];
  if (p.t === "ellipse") { const m = Math.max(p.rx, p.ry); return [p.x - m, p.y - m, p.x + m, p.y + m]; }
  if (p.t === "rrect") { const m = Math.hypot(p.w, p.h) / 2; return [p.x - m, p.y - m, p.x + m, p.y + m]; }
  if (p.t === "dot") return [p.x - p.r, p.y - p.r, p.x + p.r, p.y + p.r];
  const xs = p.pts.map((q) => q[0]), ys = p.pts.map((q) => q[1]), e = p.t === "line" ? p.w / 2 : 0;
  return [Math.min(...xs) - e, Math.min(...ys) - e, Math.max(...xs) + e, Math.max(...ys) + e];
}

/** 모양이 차지하는 칸(바닥 기준). 크기 맞추기·누르기 판정에 쓴다. */
export function shapeBounds(shape) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity;
  for (const p of shape.parts) { const b = partBox(p); x0 = Math.min(x0, b[0]); x1 = Math.max(x1, b[2]); y0 = Math.min(y0, b[1]); }
  return { x0, x1, top: Math.min(0, y0), w: Math.max(1, x1 - x0), h: Math.max(1, -Math.min(0, y0)) };
}

const rgbOf = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const mixRgb = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));
const css = ([r, g, b]) => `rgb(${r},${g},${b})`;
const INK = [58, 44, 52]; // 그늘은 검정이 아니라 고양이 그림자와 같은 보랏빛 갈색 쪽으로
const WHITE = [255, 255, 255];
/** 칠할 색. .dark 는 그늘 쪽, .light 는 밝은 쪽 */
function rgbFor(c) {
  const [base, tone] = c.split("."), rgb = rgbOf(GIFT_PALETTE[base]);
  return tone === "dark" ? mixRgb(rgb, INK, 0.32) : tone === "light" ? mixRgb(rgb, WHITE, 0.45) : rgb;
}

/** 모양 하나의 경로 */
function partPath(ctx, p) {
  ctx.beginPath();
  if (p.t === "circle") ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
  else if (p.t === "ellipse") ctx.ellipse(p.x, p.y, p.rx, p.ry, p.rot, 0, Math.PI * 2);
  else if (p.t === "dot") ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
  else if (p.t === "rrect") {
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    const w = p.w, h = p.h, r = Math.min(p.rad, w / 2, h / 2);
    ctx.moveTo(-w / 2 + r, -h / 2); ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, r); ctx.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
    ctx.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r); ctx.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r); ctx.closePath();
    ctx.restore();
  } else if (p.t === "poly") { // 꼭짓점을 round 만큼 둥글게(0 이면 뾰족 — 단풍잎·별·보석)
    const q = p.pts, n = q.length, s = [(q[n - 1][0] + q[0][0]) / 2, (q[n - 1][1] + q[0][1]) / 2];
    ctx.moveTo(s[0], s[1]);
    for (let i = 0; i < n; i++) {
      const a = q[i], b = q[(i + 1) % n], z = q[(i + n - 1) % n];
      const r = Math.min(p.round, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2, Math.hypot(z[0] - a[0], z[1] - a[1]) / 2);
      ctx.arcTo(a[0], a[1], b[0], b[1], r);
    }
    ctx.closePath();
  } else { // line: 점이 셋 이상이면 그 사이를 매끄럽게(줄기·잎맥·끈)
    const q = p.pts; ctx.moveTo(q[0][0], q[0][1]);
    for (let i = 1; i < q.length - 1; i++) ctx.quadraticCurveTo(q[i][0], q[i][1], (q[i][0] + q[i + 1][0]) / 2, (q[i][1] + q[i + 1][1]) / 2);
    ctx.lineTo(q[q.length - 1][0], q[q.length - 1][1]);
  }
}
function paintPart(ctx, p, fill) {
  partPath(ctx, p);
  if (p.t === "line") { ctx.lineWidth = p.w; ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = fill; ctx.stroke(); }
  else { ctx.fillStyle = fill; ctx.fill(); }
}

/**
 * (x, bottom) 에 모양을 그린다. unit = 한 칸의 px, edge = 가장자리 그림자 흐림(0 이면 없음).
 * 면은 위가 밝고 아래가 살짝 어두운 입체로 — 고양이 털처럼 선 없이 덩어리로 읽히게. 선·점은 고른 색 그대로.
 */
export function drawShape(ctx, shape, x, bottom, unit, edge = 0) {
  ctx.save();
  ctx.translate(x, bottom); ctx.scale(unit, unit);
  // 고양이처럼 아주 옅은 그림자로 가장자리만 띄운다(선 없이도 흰 물건이 밝은 바닥에 묻히지 않게).
  // 실루엣을 먼저 한 번 칠해 그림자를 바깥에만 두고, 도형은 그 위에 그림자 없이 칠한다. edge = 흐림(px, DPR 반영)
  if (edge > 0) {
    ctx.save(); ctx.shadowColor = "rgba(40, 28, 48, 0.32)"; ctx.shadowBlur = edge;
    for (const p of shape.parts) paintPart(ctx, p, GIFT_PALETTE.gray);
    ctx.restore();
  }
  for (const p of shape.parts) {
    const rgb = rgbFor(p.c);
    if (p.t === "line" || p.t === "dot") { paintPart(ctx, p, css(rgb)); continue; }
    const [, y0, , y1] = partBox(p), g = ctx.createLinearGradient(0, y0, 0, y1);
    g.addColorStop(0, css(mixRgb(rgb, WHITE, 0.3)));
    g.addColorStop(0.45, css(rgb));
    g.addColorStop(1, css(mixRgb(rgb, INK, 0.16)));
    paintPart(ctx, p, g);
  }
  ctx.restore();
}

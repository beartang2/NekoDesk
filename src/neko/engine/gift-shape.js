// @ts-nocheck
/**
 * 선물 모양: 모델이 적은 도형 목록(데이터)을 검사하고, 네코와 같은 그림체로 그린다. 설계: docs/neko-gifts.md §2.
 *
 * 모델은 모양만 정하고 그림체는 여기서 입힌다 — 선 없는 면, 같은 색의 밝은 윗면, 팔레트 색. 그래야 어떤 모양이
 * 와도 네코·소품(상자·그릇)과 어울린다. 모양은 데이터일 뿐이라 eval 하지 않고, 이상한 값은 잘라 내거나 버린다.
 *
 * 좌표: 32×32 칸, 가운데 x = 0, 바닥 y = 0(위가 음수). 그릴 때 unit(px/칸)을 곱한다.
 */

/** 팔레트 이름 → 실제 색. 소품과 같은 채도·밝기로 맞춰 둔다. */
export const GIFT_PALETTE = {
  red: "#e46a5e", orange: "#f0a04b", yellow: "#f5cf55", green: "#7fbf6a", teal: "#5fc0b0", blue: "#6fa8e0",
  purple: "#a98ad8", pink: "#f2a7b8", brown: "#b07a4a", gray: "#a7a39c", white: "#f4f1ea", black: "#3a3634",
  gold: "#e8b93e", silver: "#c9cdd2",
};
const KINDS = new Set(["circle", "ellipse", "rrect", "poly", "dot"]);
const MAX_PARTS = 12;
const HALF = 16;

const num = (v, lo, hi, dflt) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const color = (c) => (typeof c === "string" && GIFT_PALETTE[c] ? c : "gray");

/** 동글동글한 조약돌. 모양이 다 망가졌을 때 대신 쓴다. */
export const DEFAULT_SHAPE = Object.freeze({
  v: 1,
  parts: [
    { t: "ellipse", x: 0, y: -6, rx: 9, ry: 6, rot: 0, c: "gray" },
    { t: "dot", x: -3, y: -9, c: "white" },
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
    else if (p.t === "dot") parts.push({ t: "dot", x, y, c });
    else if (p.t === "poly" && Array.isArray(p.pts)) {
      const pts = p.pts.filter((q) => Array.isArray(q) && q.length >= 2).slice(0, 10).map((q) => [num(q[0], -HALF, HALF, 0), num(q[1], -2 * HALF, 0, 0)]);
      if (pts.length >= 3) parts.push({ t: "poly", pts, c });
    }
  }
  // 너무 작아 안 보이면(다 점이거나 한 칸짜리) 조약돌로
  const big = parts.some((p) => p.t !== "dot");
  return big ? { v: 1, parts } : DEFAULT_SHAPE;
}

/** 모양이 차지하는 칸(바닥 기준). 크기 맞추기·누르기 판정에 쓴다. */
export function shapeBounds(shape) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity;
  const add = (x, y, rx, ry) => { x0 = Math.min(x0, x - rx); x1 = Math.max(x1, x + rx); y0 = Math.min(y0, y - ry); };
  for (const p of shape.parts) {
    if (p.t === "circle") add(p.x, p.y, p.r, p.r);
    else if (p.t === "ellipse") { const m = Math.max(p.rx, p.ry); add(p.x, p.y, m, m); }
    else if (p.t === "rrect") { const m = Math.hypot(p.w, p.h) / 2; add(p.x, p.y, m, m); }
    else if (p.t === "dot") add(p.x, p.y, 1.2, 1.2);
    else for (const [x, y] of p.pts) add(x, y, 0, 0);
  }
  return { x0, x1, top: Math.min(0, y0), w: Math.max(1, x1 - x0), h: Math.max(1, -Math.min(0, y0)) };
}

function lighten(hex, k) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.round(v + (255 - v) * k);
  return `rgb(${f(r)},${f(g)},${f(b)})`;
}

/** 모양 하나의 경로 */
function partPath(ctx, p) {
  ctx.beginPath();
  if (p.t === "circle") ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
  else if (p.t === "ellipse") ctx.ellipse(p.x, p.y, p.rx, p.ry, p.rot, 0, Math.PI * 2);
  else if (p.t === "dot") ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
  else if (p.t === "rrect") {
    ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
    const w = p.w, h = p.h, r = Math.min(p.rad, w / 2, h / 2);
    ctx.moveTo(-w / 2 + r, -h / 2); ctx.arcTo(w / 2, -h / 2, w / 2, h / 2, r); ctx.arcTo(w / 2, h / 2, -w / 2, h / 2, r);
    ctx.arcTo(-w / 2, h / 2, -w / 2, -h / 2, r); ctx.arcTo(-w / 2, -h / 2, w / 2, -h / 2, r); ctx.closePath();
    ctx.restore();
  } else { // poly: 꼭짓점을 둥글게(변의 가운데를 이으며 꼭짓점을 조절점으로)
    const q = p.pts, n = q.length, mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const s = mid(q[n - 1], q[0]); ctx.moveTo(s[0], s[1]);
    for (let i = 0; i < n; i++) { const m = mid(q[i], q[(i + 1) % n]); ctx.quadraticCurveTo(q[i][0], q[i][1], m[0], m[1]); }
    ctx.closePath();
  }
}

/**
 * (x, bottom) 에 모양을 그린다. unit = 한 칸의 px. 선 없이 면 → 같은 색 밝은 윗면(위쪽 절반에만) 순서로,
 * 소품(상자의 밝은 띠, 그릇의 밝은 테)과 같은 결.
 */
export function drawShape(ctx, shape, x, bottom, unit) {
  ctx.save();
  ctx.translate(x, bottom); ctx.scale(unit, unit);
  for (const p of shape.parts) {
    const col = GIFT_PALETTE[p.c];
    ctx.fillStyle = col; partPath(ctx, p); ctx.fill();
    if (p.t === "dot") continue;
    ctx.save(); partPath(ctx, p); ctx.clip();
    ctx.fillStyle = lighten(col, 0.35);
    const b = shapeBounds({ parts: [p] });
    ctx.beginPath(); ctx.ellipse((b.x0 + b.x1) / 2 - b.w * 0.12, b.top + b.h * 0.18, b.w * 0.42, b.h * 0.22, -0.3, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  ctx.restore();
}

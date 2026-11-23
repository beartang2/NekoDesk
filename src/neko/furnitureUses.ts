import { DEFAULT_SHAPE, validateShape, type GiftPart, type GiftShape } from "./engine/gift-shape";
import { FURNITURE_ART } from "./engine/furniture-art";
import type { FurnitureKind } from "./furniture";

/**
 * 자유 가구의 쓰임새 검사·보정(docs/neko-furniture-free.md §6). 모델이 그린 모양(고양이 키 CAT_U 칸 축척)과 고른 쓰임새를 받아,
 * 그림 윤곽(0.5칸 격자로 칠해졌나 판정)에 맞춰 자리를 고치거나 버린다. 캔버스 없이 도는 순수 함수라 같은 입력이면 언제나 같은
 * 값이 나온다 — 저장 전과 읽을 때(옛 값·다른 기기 값) 같은 길을 거친다. 칸: 가운데 x 0, 바닥 y 0, 위가 음수(선물 모양과 같다).
 */

/** 고양이 키 = 12칸. 선물 모양 칸(가로 ±16, 높이 32)에 높이 2배·폭 2.7배까지 든다 */
export const CAT_U = 12;
const STEP = 0.5;
const HALF = 16, TOP = 32;
/** 가구 높이(고양이 키 0.4~2배) */
const MIN_H = 0.4 * CAT_U, MAX_H = 2 * CAT_U;

export type FurnUse =
  /** 올라앉는 면: 높이 y(음수)·가로 x0–x1. soft = 푹신해 꾹꾹이·잘 자리 */
  | { u: "perch"; y: number; x0: number; x1: number; soft?: true }
  /** 들어가 숨기: 입구 x0–x1, 테두리 높이 rim(음수), 고양이 앞에 다시 그릴 도형 번호 */
  | { u: "inside"; x0: number; x1: number; rim: number; front: number[] }
  /** 발톱 긁기: 옆면(왼·오른쪽), 긁는 x, 옆면이 이어진 꼭대기 top(음수) */
  | { u: "scratch"; side: "left" | "right"; x: number; top: number }
  /** 매달린 것 치기: 그 점 */
  | { u: "bat"; x: number; y: number };
export const USE_KINDS = ["perch", "inside", "scratch", "bat"] as const;
const MAX_USES = 4;

// ── 칠해졌나(도형마다) ─────────────────────────────────────────────────────────

function segDist(px: number, py: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l)) : 0;
  return Math.hypot(px - a[0] - t * dx, py - a[1] - t * dy);
}

export function partHit(p: GiftPart, x: number, y: number): boolean {
  switch (p.t) {
    case "circle": case "dot": return (x - p.x) ** 2 + (y - p.y) ** 2 <= p.r ** 2;
    case "ellipse": {
      const c = Math.cos(p.rot), s = Math.sin(p.rot), dx = x - p.x, dy = y - p.y;
      const lx = dx * c + dy * s, ly = -dx * s + dy * c;
      return (lx / p.rx) ** 2 + (ly / p.ry) ** 2 <= 1;
    }
    case "rrect": {
      const c = Math.cos(p.rot), s = Math.sin(p.rot), dx = x - p.x, dy = y - p.y;
      const lx = Math.abs(dx * c + dy * s), ly = Math.abs(-dx * s + dy * c), hw = p.w / 2, hh = p.h / 2;
      if (lx > hw || ly > hh) return false;
      const r = Math.min(p.rad, hw, hh);
      return lx <= hw - r || ly <= hh - r || Math.hypot(lx - (hw - r), ly - (hh - r)) <= r;
    }
    case "poly": {
      let inside = false;
      for (let i = 0, j = p.pts.length - 1; i < p.pts.length; j = i++) {
        const [xi, yi] = p.pts[i], [xj, yj] = p.pts[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    }
    case "line":
      for (let i = 1; i < p.pts.length; i++) if (segDist(x, y, p.pts[i - 1] as [number, number], p.pts[i] as [number, number]) <= p.w / 2) return true;
      return false;
  }
}

/** 0.5칸 격자로 칠해진 곳. 열(x)·행(y) 번호는 col(x)·row(y) */
interface Grid { on: (x: number, y: number) => boolean; xs: number[]; ys: number[] }
const COLS = Array.from({ length: (2 * HALF) / STEP + 1 }, (_, i) => -HALF + i * STEP);
const ROWS = Array.from({ length: TOP / STEP + 1 }, (_, i) => -TOP + i * STEP); // 위(−32)부터 바닥(0)까지
const key = (x: number, y: number) => `${Math.round(x / STEP)},${Math.round(y / STEP)}`;

function grid(parts: GiftPart[]): Grid {
  const set = new Set<string>();
  for (const x of COLS) for (const y of ROWS) if (parts.some((p) => partHit(p, x, y))) set.add(key(x, y));
  return { on: (x, y) => set.has(key(x, y)), xs: COLS, ys: ROWS };
}
/** 열마다 맨 위 칠해진 y(없으면 null) */
const topOf = (g: Grid, x: number): number | null => g.ys.find((y) => g.on(x, y)) ?? null;

// ── 모양 옮기기·줄이기 ─────────────────────────────────────────────────────────

const r2 = (v: number) => Math.round(v * 100) / 100;
function moveParts(parts: GiftPart[], k: number, dy: number): GiftPart[] {
  const P = (q: number[]): [number, number] => [r2(q[0] * k), r2(q[1] * k + dy)];
  return parts.map((p): GiftPart => {
    switch (p.t) {
      case "circle": case "dot": return { ...p, x: r2(p.x * k), y: r2(p.y * k + dy), r: r2(p.r * k) };
      case "ellipse": return { ...p, x: r2(p.x * k), y: r2(p.y * k + dy), rx: r2(p.rx * k), ry: r2(p.ry * k) };
      case "rrect": return { ...p, x: r2(p.x * k), y: r2(p.y * k + dy), w: r2(p.w * k), h: r2(p.h * k), rad: r2(p.rad * k) };
      case "poly": return { ...p, pts: p.pts.map(P), round: r2(p.round * k) };
      case "line": return { ...p, pts: p.pts.map(P), w: r2(p.w * k) };
    }
  });
}

// ── 쓰임새마다 ─────────────────────────────────────────────────────────────────

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** 윗선에서 평평한 구간(이웃 열 차이 FLAT 이하, 폭 SEAT 이상): [x0, x1, 윗선 가운데값] */
const FLAT = 0.05 * CAT_U, SEAT = 0.45 * CAT_U;
function flatRuns(g: Grid): { x0: number; x1: number; y: number }[] {
  const runs: { x0: number; x1: number; y: number }[] = [];
  let cur: { xs: number[]; tops: number[] } | null = null;
  const close = () => {
    if (cur && cur.xs[cur.xs.length - 1] - cur.xs[0] >= SEAT) runs.push({ x0: cur.xs[0], x1: cur.xs[cur.xs.length - 1], y: median(cur.tops) });
    cur = null;
  };
  for (const x of g.xs) {
    const t = topOf(g, x);
    if (t === null || t > -0.1 * CAT_U) { close(); continue; } // 바닥에 붙은 데는 면이 아니다
    if (cur && Math.abs(t - cur.tops[cur.tops.length - 1]) <= FLAT) { cur.xs.push(x); cur.tops.push(t); }
    else { close(); cur = { xs: [x], tops: [t] }; }
  }
  close();
  return runs;
}
/** 면 위 앉은 고양이 키(0.75) 안에 칠해진 데가 가운데 60% 의 절반 넘게 덮으면 지붕 아래다 */
function roofed(g: Grid, r: { x0: number; x1: number; y: number }): boolean {
  const m = (r.x1 - r.x0) * 0.2, xs = g.xs.filter((x) => x >= r.x0 + m && x <= r.x1 - m);
  const covered = xs.filter((x) => g.ys.some((y) => y < r.y - STEP && y >= r.y - 0.75 * CAT_U && g.on(x, y)));
  return covered.length > xs.length / 2;
}
const PERCH_MAX = 1.6 * CAT_U;
const perchOk = (g: Grid, r: { x0: number; x1: number; y: number }) => -r.y <= PERCH_MAX && !roofed(g, r);

function perch(g: Grid, raw: Record<string, unknown>): FurnUse | null {
  const y = num(raw.y), a = num(raw.x0), b = num(raw.x1);
  if (y === null || a === null || b === null) return null;
  const x0 = Math.min(a, b), x1 = Math.max(a, b);
  let best: { x0: number; x1: number; y: number } | null = null, bestOv = 0;
  for (const r of flatRuns(g)) {
    const ov = Math.min(x1, r.x1) - Math.max(x0, r.x0);
    if (ov <= 0 || Math.abs(r.y - y) > 0.2 * CAT_U) continue;
    if (ov < 0.5 * Math.min(x1 - x0 || ov, r.x1 - r.x0)) continue;
    if (ov > bestOv) { best = r; bestOv = ov; }
  }
  if (!best || !perchOk(g, best)) return null;
  return { u: "perch", y: best.y, x0: best.x0 + 0.5, x1: best.x1 - 0.5, ...(raw.soft === true ? { soft: true as const } : {}) };
}

function inside(parts: GiftPart[], raw: Record<string, unknown>): FurnUse | null {
  const a = num(raw.x0), b = num(raw.x1), rim0 = num(raw.rim);
  const front = Array.isArray(raw.front) ? [...new Set(raw.front.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < parts.length))].sort((x, y) => x - y) : [];
  if (a === null || b === null || rim0 === null || !front.length) return null;
  const fg = grid(front.map((i) => parts[i]));
  const x0 = Math.min(a, b), x1 = Math.max(a, b);
  // 테두리: 입구 안 앞 겹 윗선의 가운데값
  const tops = fg.xs.filter((x) => x >= x0 && x <= x1).map((x) => topOf(fg, x)).filter((t): t is number => t !== null);
  if (!tops.length) return null;
  const rim = median(tops);
  // 입구 폭: 테두리 바로 아래 줄의 앞 겹 좌우 끝(모델이 적은 입구와 겹치는 덩어리)
  const row = rim + 0.1 * CAT_U, on = fg.xs.filter((x) => fg.on(x, Math.round(row / STEP) * STEP));
  const left = on.filter((x) => x <= (x0 + x1) / 2), right = on.filter((x) => x >= (x0 + x1) / 2);
  if (!left.length || !right.length) return null;
  const ox0 = Math.max(Math.min(...left), x0 - 0.2 * CAT_U), ox1 = Math.min(Math.max(...right), x1 + 0.2 * CAT_U);
  if (ox1 - ox0 < 0.6 * CAT_U || -rim < 0.2 * CAT_U || -rim > 0.9 * CAT_U) return null;
  // 앞 겹이 입구 아래 칸(ox0–ox1, rim–바닥)을 60% 이상 덮어야 고양이가 '안에' 보인다
  let n = 0, hit = 0;
  for (const x of fg.xs) if (x >= ox0 && x <= ox1) for (const y of fg.ys) if (y >= rim && y <= 0) { n++; if (fg.on(x, y)) hit++; }
  if (!n || hit / n < 0.6) return null;
  return { u: "inside", x0: ox0, x1: ox1, rim, front };
}

function scratch(g: Grid, raw: Record<string, unknown>): FurnUse | null {
  const side = raw.side === "left" || raw.side === "right" ? raw.side : null;
  if (!side) return null;
  // 바닥부터 위로: 줄마다 그 옆 끝 x. 줄이 비거나 옆선이 크게 꺾이면(0.25 고양이 넘게) 거기까지
  const edges: { y: number; x: number }[] = [];
  for (const y of [...g.ys].reverse()) {
    if (y > -STEP / 2) continue;
    const on = g.xs.filter((x) => g.on(x, y));
    if (!on.length) break;
    const x = side === "left" ? Math.min(...on) : Math.max(...on);
    if (edges.length && Math.abs(x - edges[edges.length - 1].x) > 0.25 * CAT_U) break;
    edges.push({ y, x });
    if (-y >= 0.9 * CAT_U) break;
  }
  if (!edges.length || -edges[edges.length - 1].y < 0.4 * CAT_U || edges[0].y < -0.1 * CAT_U) return null;
  return { u: "scratch", side, x: median(edges.map((e) => e.x)), top: edges[edges.length - 1].y };
}

function bat(g: Grid, raw: Record<string, unknown>): FurnUse | null {
  const x = num(raw.x), y = num(raw.y);
  if (x === null || y === null) return null;
  // 2칸(고양이 0.15) 안의 가장 가까운 칠해진 점
  let best: [number, number] | null = null, bd = Infinity;
  const R = 0.15 * CAT_U;
  for (const gx of g.xs) if (Math.abs(gx - x) <= R) for (const gy of g.ys) if (Math.abs(gy - y) <= R && g.on(gx, gy)) {
    const d = Math.hypot(gx - x, gy - y);
    if (d < bd) { bd = d; best = [gx, gy]; }
  }
  if (!best || -best[1] < 0.5 * CAT_U || -best[1] > 1.3 * CAT_U) return null;
  // 그 아래 설 자리: 바닥에서 그 점까지 칠해진 데가 40% 이하
  const below = g.ys.filter((yy) => yy > best![1] + STEP && yy <= 0);
  if (below.filter((yy) => g.on(best![0], yy)).length > below.length * 0.4) return null;
  return { u: "bat", x: best[0], y: best[1] };
}

// ── 한데 ───────────────────────────────────────────────────────────────────────

/**
 * 모델이 낸 모양·쓰임새 → 검사를 거친 가구. 가구가 아니면(너무 낮음) null — 부르는 쪽이 선물로 돌린다.
 * 바닥에서 뜬 모양은 바닥까지 내리고, 높이 MAX_H 를 넘으면 통째로 줄인다(쓰임새 좌표도 같이 — 줄인 뒤 다시 본다).
 */
export function checkFurniture(rawShape: unknown, rawUses: unknown): { shape: GiftShape; uses: FurnUse[] } | null {
  const v = validateShape(rawShape);
  if (v === DEFAULT_SHAPE) return null; // 쓸 만한 도형이 없었다
  const g0 = grid(v.parts);
  const filled = g0.ys.filter((y) => g0.xs.some((x) => g0.on(x, y)));
  if (!filled.length) return null;
  const top = Math.min(...filled), bottom = Math.max(...filled);
  const h = bottom - top;
  if (h < MIN_H) return null;
  const k = h > MAX_H ? MAX_H / h : 1, dy = -bottom * k; // 바닥까지 내리고(맨 아래 = 0), 높으면 줄인다
  const shape: GiftShape = k === 1 && !dy ? v : { ...v, parts: moveParts(v.parts, k, dy) };
  const g = k === 1 && !dy ? g0 : grid(shape.parts);
  const T = (n: unknown) => (num(n) === null ? n : r2((n as number) * k + dy)), X = (n: unknown) => (num(n) === null ? n : r2((n as number) * k));
  const uses: FurnUse[] = [];
  for (const raw of Array.isArray(rawUses) ? rawUses : []) {
    if (uses.length >= MAX_USES || !raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>, moved = { ...r, x0: X(r.x0), x1: X(r.x1), x: X(r.x), y: T(r.y), rim: T(r.rim) };
    let u: FurnUse | null = null;
    if (r.u === "perch") u = perch(g, moved);
    else if (r.u === "inside" && !uses.some((o) => o.u === "inside")) u = inside(shape.parts, moved);
    else if (r.u === "scratch" && !uses.some((o) => o.u === "scratch" && o.side === r.side)) u = scratch(g, moved);
    else if (r.u === "bat" && !uses.some((o) => o.u === "bat")) u = bat(g, moved);
    // 올라앉는 면은 높이가 다른 것만 여럿(같은 면을 두 번 짚었으면 하나)
    if (u?.u === "perch" && uses.some((o) => o.u === "perch" && Math.abs(o.y - (u as { y: number }).y) < 0.25 * CAT_U)) u = null;
    if (u) uses.push(u);
  }
  return { shape, uses };
}

/**
 * 이미 물어온 가구(0.1.27 까지, 다섯 kind 중 하나 + 32칸에 꽉 찬 그림): 그 kind 의 기준 키(폭으로 정하는 kind 는 폭)로 고양이 키
 * CAT_U 축척에 옮기고, 윗선에서 평평한 면 중 가장 넓은 것(올라앉을 수 있는 높이·지붕 없음) 하나를 올라앉기로 붙인다(사용자 결정 A —
 * 쓰임새를 적은 모델이 없어 코드가 면만 만든다). 전용 동작(캣휠 달리기·조명·상자)은 안 붙인다
 */
export function oldFurnitureAsFree(shape: GiftShape, kind: FurnitureKind): { shape: GiftShape; uses: FurnUse[] } | null {
  const v = validateShape(shape), art = FURNITURE_ART[kind];
  const g0 = grid(v.parts);
  const cols = g0.xs.filter((x) => g0.ys.some((y) => g0.on(x, y))), rows = g0.ys.filter((y) => g0.xs.some((x) => g0.on(x, y)));
  if (!cols.length || !rows.length) return null;
  const span = art.by === "w" ? cols[cols.length - 1] - cols[0] : rows[rows.length - 1] - rows[0];
  const k0 = (art.size * CAT_U) / Math.max(span, 1), bottom = rows[rows.length - 1];
  // 줄였을 때 판(가로 ±16·높이 32)을 넘으면 더 줄인다
  const wide = Math.max(Math.abs(cols[0]), Math.abs(cols[cols.length - 1])) * k0, tall = (bottom - rows[0]) * k0;
  const k = k0 * Math.min(1, HALF / Math.max(wide, 0.01), MAX_H / Math.max(tall, 0.01));
  const parts = moveParts(v.parts, k, -bottom * k), out: GiftShape = { ...v, parts };
  const g = grid(parts);
  const runs = flatRuns(g).filter((r) => perchOk(g, r)).sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0) || b.y - a.y);
  const r = runs[0];
  return { shape: out, uses: r ? [{ u: "perch", y: r.y, x0: r.x0 + 0.5, x1: r.x1 - 0.5 }] : [] };
}

/**
 * 놓아 둔 선물의 크기·자리 계산과 그리기(엔진 없이도). 엔진과 모니터별 선물 창이 같이 쓴다 — 계산이 같아야
 * 고양이가 다른 모니터로 건너가 엔진이 그 모니터 선물을 이어받을 때 선물이 튀지 않는다. 설계: docs/neko-gifts.md §4
 *
 * geom = { W, floorY, S }: 무대 폭(px)·바닥 y(px)·배율. 자리는 비율이다 — 바닥: u = 양끝 여백을 뺀 폭 비율,
 * 벽: u 와 v = 바닥 위 쓸 수 있는 높이 비율(0~1).
 */
import { validateShape, shapeBounds, drawShape } from "./gift-shape.js";

export const DECOR_SIZE = 32;  // 한 변(S 단위) — 잎맥·꼭지 같은 결이 보이게, 머리(폭 74)의 절반 남짓
export const WALL_GAP = 18;    // 바닥에서 이만큼(S) 넘게 띄워 놓으면 벽에 건다
/** 물건 크기(실제 크기를 모델이 고름). 큰 것도 고양이 몸(길이 약 100)보다 작게 */
export const SIZE_K = { small: 0.6, medium: 1, large: 1.45 };
export const sizeK = (size) => (Object.hasOwn(SIZE_K, size) ? SIZE_K[size] : 1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** 물건 한 개의 크기(px)와 그리기 배율 u */
export function decorDims(shape, k, S) {
  const bd = shapeBounds(shape), u = (DECOR_SIZE * k * S) / Math.max(bd.w, bd.h);
  return { bd, u, w: bd.w * u, h: bd.h * u };
}
export const decorM = (S) => 16 * S;
/** 벽 v = 1 이면 물건 위가 무대 위에서 10 아래 */
export const wallSpan = (h, g) => Math.max(1, g.floorY - h - 10 * g.S);
/** 자리(면·비율) → 그릴 자리(가운데 x, 바닥 y) */
export function decorAt(d, h, g) {
  const m = decorM(g.S), x = m + d.u * Math.max(0, g.W - 2 * m);
  return [x, d.surface === "wall" ? g.floorY - (d.v ?? 0.5) * wallSpan(h, g) : g.floorY];
}
/** 끄는 중인 물건(높이 h)을 무대 안에 묶는다: 양끝 여백 안, 바닥 아래로는 안 내려가고 무대 위로도 안 나간다 */
export const clampDrag = (h, g, x, bottom) => [clamp(x, decorM(g.S), g.W - decorM(g.S)), clamp(bottom, h + 10 * g.S, g.floorY)];
/** 끌어 들어 올린 모양: 조금 크고 가장자리 그림자가 더 흐리다. 바닥 가까이면 바닥 그림자 */
const LIFT = 1.08;
const liftedOnFloor = (bottom, g) => g.floorY - bottom < WALL_GAP * g.S;
/** 무대의 한 점(물건 가운데 x, 바닥 y) → 자리(면·비율). 바닥 가까이면 바닥, 높이 띄우면 벽 */
export function spotOf(x, bottom, h, g) {
  const m = decorM(g.S), u = clamp((x - m) / Math.max(1, g.W - 2 * m), 0, 1);
  return g.floorY - bottom < WALL_GAP * g.S ? { surface: "floor", u } : { surface: "wall", u, v: clamp((g.floorY - bottom) / wallSpan(h, g), 0, 1) };
}

/**
 * 물건 하나를 g 에 그린다. L = { bd, u, w, h, x, bottom, onFloor }(decorDims + 자리).
 * o: shadow 색, sc 뿅 배율 [x, y], rot 구르기, wob 흔들림, edge 가장자리 그림자(px), dark 아님
 */
export function paintDecor(g, shape, L, geom, o = {}) {
  const { bd, u, h, x, bottom, onFloor } = L, S = geom.S, sc = o.sc || [1, 1];
  if (onFloor) { // 고양이와 같은 바닥 그림자
    g.save(); g.globalAlpha = 0.5; g.fillStyle = o.shadow || "rgba(20, 14, 24, 0.18)";
    g.beginPath(); g.ellipse(x, geom.floorY + 1 * S, L.w * 0.5, 2.6 * S, 0, 0, Math.PI * 2); g.fill(); g.restore();
  }
  if (sc[0] <= 0.002 || sc[1] <= 0.002) return;
  g.save();
  g.translate(x, bottom); g.scale(sc[0], sc[1]); g.translate(-x, -bottom);
  // 굴러가면 가운데를 축으로 돌고(rot), 앞발로 톡 치면 바닥을 축으로 흔들린다(wob)
  g.save();
  g.translate(x, bottom - h / 2); g.rotate(o.rot || 0); g.translate(-x, -(bottom - h / 2));
  g.translate(x, bottom); g.rotate(o.wob || 0); g.translate(-x, -bottom);
  drawShape(g, shape, x - ((bd.x0 + bd.x1) / 2) * u, bottom, u, o.edge ?? 4);
  g.restore();
  if (!onFloor) { // 벽에 건 것: 위에 작은 압정
    g.fillStyle = "#8f8a86"; g.beginPath(); g.arc(x, bottom - h + 1.5 * S, 1.8 * S, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(255,255,255,0.6)"; g.beginPath(); g.arc(x - 0.5 * S, bottom - h + 1 * S, 0.7 * S, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/** 놓인 물건(setDecor 와 같은 모양) → 그릴 자리 목록. 모양이 이상하면 검사에서 기본 모양으로 바뀐다.
 *  drag = { id, x, bottom }: 끄는 물건은 그 자리(clampDrag 로 묶은 값)에 들어 올린 모양으로 */
function layoutAll(items, geom, drag) {
  return (items || []).filter((d) => d && d.id != null && Number.isFinite(d.u)).map((d) => {
    const shape = validateShape(d.shape), dims = decorDims(shape, sizeK(d.size), geom.S), id = String(d.id);
    if (drag && String(drag.id) === id) {
      const [x, bottom] = clampDrag(dims.h, geom, drag.x, drag.bottom);
      return { id, shape, L: { ...dims, x, bottom, onFloor: liftedOnFloor(bottom, geom) }, lifted: true };
    }
    const spot = { surface: d.surface === "wall" ? "wall" : "floor", u: clamp(d.u, 0, 1), v: clamp(Number.isFinite(d.v) ? d.v : 0.5, 0, 1) };
    const [x, bottom] = decorAt(spot, dims.h, geom);
    return { id, shape, L: { ...dims, x, bottom, onFloor: spot.surface === "floor" } };
  });
}
const geomOf = ({ W, floorY, scale }) => ({ W, floorY, S: clamp(Number.isFinite(scale) ? scale : 1, 0.35, 1.4) });

/**
 * 엔진 없이 선물만 그린다(모니터별 선물 창). 캔버스를 W×H(css px) × dpr 로 맞추고 다 지운 뒤 그린다.
 * 멈춘 모양이다(뿅·흔들림·구르기 없음) — 바뀔 때만 부르면 된다. scale 은 엔진 setScale 과 같은 값.
 * drag = { id, x, bottom }: 사용자가 끄는 물건(물건 가운데 x, 바닥 y). 엔진 끌기와 같게 묶고 들어 올린 모양으로 맨 위에
 */
export function drawDecor(canvas, items, { W, H, floorY, scale, dpr = 1, dark = false, drag = null }) {
  const geom = geomOf({ W, floorY, scale }), bw = Math.round(W * dpr), bh = Math.round(H * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  const g = canvas.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, bw, bh);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const shadow = dark ? "rgba(0, 0, 0, 0.32)" : "rgba(20, 14, 24, 0.18)";
  const all = layoutAll(items, geom, drag);
  for (const it of [...all.filter((o) => !o.lifted), ...all.filter((o) => o.lifted)]) {
    paintDecor(g, it.shape, it.L, geom, it.lifted ? { shadow, sc: [LIFT, LIFT], edge: 7 * dpr } : { shadow, edge: 4 * dpr });
  }
}

/** 놓인 물건마다 그린 칸(css px, 그린 순서). 누르기 판정과 '정리' 버튼 자리(엔진은 칸 오른쪽 위 x + w, y)에 쓴다 */
export function decorBoxes(items, { W, floorY, scale }) {
  return layoutAll(items, geomOf({ W, floorY, scale })).map(({ id, L }) => ({ id, x: L.x - L.w / 2, y: L.bottom - L.h, w: L.w, h: L.h }));
}

/** 이 점(css px)이 놓인 물건 위면 그 id(위에 그린 것부터). drawDecor 와 같은 자리, 엔진 hitDecor 와 같은 여유 */
export function hitDecorAt(items, view, x, y) {
  const all = decorBoxes(items, view), pad = 3 * geomOf(view).S;
  for (let i = all.length - 1; i >= 0; i--) {
    const b = all[i];
    if (x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad) return b.id;
  }
  return null;
}

/**
 * 끄는 중: 물건 id 를 (물건 가운데 x, 바닥 y)로 옮기면 실제로 그릴 자리(무대 안으로 묶음)와 놓을 자리(면·비율).
 * 놓을 때 spot 을 gifts place 로 넘기면 엔진 끌기와 같은 자리가 된다. 없는 id 면 null
 */
export function dragDecor(items, view, id, x, bottom) {
  const geom = geomOf(view), it = layoutAll(items, geom).find((o) => o.id === String(id));
  if (!it) return null;
  const [cx, cb] = clampDrag(it.L.h, geom, x, bottom);
  return { x: cx, bottom: cb, spot: spotOf(cx, cb, it.L.h, geom) };
}

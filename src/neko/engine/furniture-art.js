/**
 * 가구 그림(docs/neko-furniture.md §9): 조명·2층 캣타워·캣휠·소파·상자. 엔진(활동 중)·정지 그림 층·선물함 칸이 같이 쓴다.
 * 그림체는 선물과 같다(gift-shape drawShape: 선 없이 면, 위 밝게·아래 INK, 옅은 가장자리 그림자). 모양 좌표는 바닥 가운데가 (0,0),
 * 위가 음수인 칸 단위이고, 기준 키(고양이 키 100·S 단위)에 맞춰 키운다. 크기는 고양이를 따라 S 로 줄고 는다(폰 70% 도 그대로).
 */
import { drawShape } from "./gift-shape.js";

/** 고양이 키(S 단위) — decor-draw CAT_H 와 같다 */
const CAT = 100;

const LAMP_PARTS = (on) => [
  { t: "ellipse", x: 0, y: -1.2, rx: 6, ry: 1.6, rot: 0, c: "gray.dark" },
  { t: "line", pts: [[0, -1.5], [0, -25]], w: 1.3, c: "gray.dark" },
  { t: "poly", pts: [[-7, -23], [7, -23], [4.5, -32], [-4.5, -32]], round: 1.2, c: on ? "yellow.light" : "white" },
  { t: "rrect", x: 0, y: -23, w: 14, h: 1.2, rad: 0.6, rot: 0, c: on ? "yellow" : "gray" },
];
// 캣타워: 1층 발판 윗변 0.8, 2층 1.5, 맨 위 기둥 끝 1.8(고양이 키) — 32 칸 = 1.8 이라 한 칸 = 0.05625
const TOWER_PARTS = [
  { t: "rrect", x: 0, y: -1.5, w: 22, h: 3, rad: 1.2, rot: 0, c: "brown" },
  { t: "rrect", x: -5, y: -8.4, w: 3.6, h: 11, rad: 1, rot: 0, c: "brown.light" },
  { t: "rrect", x: -2, y: -13, w: 17, h: 2.4, rad: 1.1, rot: 0, c: "brown" },
  { t: "rrect", x: 5, y: -19.9, w: 3.6, h: 11.6, rad: 1, rot: 0, c: "brown.light" },
  { t: "rrect", x: 3.5, y: -25.5, w: 15, h: 2.4, rad: 1.1, rot: 0, c: "brown" },
  { t: "rrect", x: -2.5, y: -29.4, w: 2.6, h: 5.6, rad: 0.9, rot: 0, c: "brown.light" },
  { t: "line", pts: [[-2.5, -31.4], [-7.5, -31.4], [-7.5, -28]], w: 0.5, c: "gray" },
  { t: "dot", x: -7.5, y: -27.2, r: 1.3, c: "red" },
];
/** 캣타워 방석(포인트 색으로 따로 칠한다): 2층 발판 위 타원 */
const TOWER_CUSHION = { x: 4, y: -27.4, rx: 6, ry: 1.5 };
// 캣휠: 바퀴 가운데 (0, -16.5), 테 반지름 15.5 — 다리·받침·테·레일·판은 그대로, 이음 자국과 발바닥 로고만 돈다
const WHEEL_CY = -16.5;
const WHEEL_STILL = [
  { t: "poly", pts: [[-10, 0], [-6.5, 0], [0, -16], [-1.6, -16]], round: 0.6, c: "brown" },
  { t: "poly", pts: [[10, 0], [6.5, 0], [0, -16], [1.6, -16]], round: 0.6, c: "brown" },
  { t: "rrect", x: 0, y: -0.8, w: 22, h: 1.6, rad: 0.8, rot: 0, c: "brown.dark" },
  { t: "circle", x: 0, y: WHEEL_CY, r: 15.5, c: "brown" },
  { t: "circle", x: 0, y: WHEEL_CY, r: 13.4, c: "gray.dark" },
  { t: "circle", x: 0, y: WHEEL_CY, r: 11.2, c: "brown.light" },
];
/** 도는 것(바퀴 가운데 기준 좌표): 테의 이음 자국 6개, 앞면 발바닥 로고 */
const WHEEL_SPIN = [
  ...Array.from({ length: 6 }, (_, i) => {
    const a = (i * Math.PI) / 3;
    return { t: "rrect", x: Math.cos(a) * 14.45, y: Math.sin(a) * 14.45, w: 0.7, h: 2.2, rad: 0.3, rot: a, c: "brown.dark" };
  }),
  { t: "ellipse", x: 0, y: 1.5, rx: 2.6, ry: 2.1, rot: 0, c: "white" },
  { t: "dot", x: -2.9, y: -1.8, r: 1, c: "white" },
  { t: "dot", x: -1, y: -3.1, r: 1, c: "white" },
  { t: "dot", x: 1, y: -3.1, r: 1, c: "white" },
  { t: "dot", x: 2.9, y: -1.8, r: 1, c: "white" },
];
// 소파: 폭 34 칸 = 고양이 키 2.2, 높이 14 칸 ≈ 0.9
const SOFA_PARTS = [
  { t: "rrect", x: -12, y: -1, w: 2, h: 2, rad: 0.5, rot: 0, c: "brown.dark" },
  { t: "rrect", x: 12, y: -1, w: 2, h: 2, rad: 0.5, rot: 0, c: "brown.dark" },
  { t: "rrect", x: 0, y: -10.5, w: 28, h: 7, rad: 2.6, rot: 0, c: "blue.dark" },
  { t: "rrect", x: 0, y: -4.5, w: 28, h: 5, rad: 2.2, rot: 0, c: "blue" },
  { t: "rrect", x: -6.8, y: -8.2, w: 12.6, h: 2.8, rad: 1.4, rot: 0, c: "blue.light" },
  { t: "rrect", x: 6.8, y: -8.2, w: 12.6, h: 2.8, rad: 1.4, rot: 0, c: "blue.light" },
  { t: "rrect", x: -14.5, y: -6.5, w: 5, h: 9, rad: 2.3, rot: 0, c: "blue" },
  { t: "rrect", x: 14.5, y: -6.5, w: 5, h: 9, rad: 2.3, rot: 0, c: "blue" },
];
// 상자: 뒤 겹(안쪽 그늘 벽·뒤 날개)과 앞 겹(앞 벽·앞 날개·테이프). 고양이가 들어가면 그 사이에 그린다. 18.5 칸 = 0.8
const BOX_BACK = [
  { t: "poly", pts: [[-10.5, -16], [-1, -16], [-3, -18.5], [-11.5, -18]], round: 0.4, c: "orange" },
  { t: "poly", pts: [[10.5, -16], [1, -16], [3, -18.5], [11.5, -18]], round: 0.4, c: "orange" },
  { t: "rrect", x: 0, y: -9, w: 21, h: 14, rad: 0.6, rot: 0, c: "brown" },
];
const BOX_FRONT = [
  { t: "rrect", x: 0, y: -6, w: 22, h: 12, rad: 0.9, rot: 0, c: "brown.light" },
  { t: "rrect", x: 0, y: -11.6, w: 22, h: 1, rad: 0.4, rot: 0, c: "brown" },
  { t: "poly", pts: [[-11, -12], [-1, -12], [-3, -15.5], [-13.5, -14.5]], round: 0.5, c: "orange.light" },
  { t: "poly", pts: [[11, -12], [1, -12], [3, -15.8], [13.8, -14.2]], round: 0.5, c: "orange.light" },
  { t: "rrect", x: 0, y: -7, w: 3, h: 6, rad: 0.5, rot: 0, c: "white" },
];

/**
 * 가구마다: 기준 크기(고양이 키 단위, by = 키 "h" 나 폭 "w" 에 맞춘다), 모양 칸(span = 그 방향의 칸 수), 올라앉는 면
 * (y = 바닥에서 높이, x0·x1 = 가운데에서 가로 — 모두 고양이 키 단위)
 */
export const FURNITURE_ART = {
  lamp: { size: 1.5, by: "h", span: 32, surfaces: [] },
  cattower: { size: 1.8, by: "h", span: 32, surfaces: [{ y: 0.8, x0: -0.59, x1: 0.37 }, { y: 1.5, x0: -0.22, x1: 0.62 }] },
  wheel: { size: 1.3, by: "h", span: 32, surfaces: [] },
  sofa: { size: 2.2, by: "w", span: 34, surfaces: [{ y: 0.62, x0: -0.86, x1: 0.86 }] },
  box: { size: 0.8, by: "h", span: 18.5, surfaces: [] },
};
/** 모양의 폭·높이(칸) */
const EXTENT = { lamp: [14, 32], cattower: [22, 32], wheel: [31, 32], sofa: [34, 14], box: [27.6, 18.5] };

/** 한 칸의 px 와 그린 크기(px). slotW 를 주면 폭이 칸의 90% 를 넘지 않게 줄인다(키·폭을 같이, 고양이 대비보다 칸이 먼저) */
export function furnitureBox(kind, S, slotW) {
  const a = FURNITURE_ART[kind], [ew, eh] = EXTENT[kind];
  let u = (a.size * CAT * S) / a.span;
  if (slotW > 0 && ew * u > 0.9 * slotW) u = (0.9 * slotW) / ew;
  return { u, w: ew * u, h: eh * u, fit: u / ((a.size * CAT * S) / a.span) };
}

/** 올라앉는 면(px, 가운데 x·바닥 y 기준): 엔진이 캣타워·소파 위에 앉을 때. 칸 맞춤으로 줄면 면도 같이 */
export function furnitureSurfaces(kind, S, slotW) {
  const { fit } = furnitureBox(kind, S, slotW), k = CAT * S * fit;
  return FURNITURE_ART[kind].surfaces.map((s) => ({ y: s.y * k, x0: s.x0 * k, x1: s.x1 * k }));
}

const rgb = (hex) => { const n = parseInt(hex.replace("#", ""), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));

/**
 * 가구 하나를 (x, bottom) 에 그린다. S = 무대 배율.
 * o: on(조명 켜짐) · accent(포인트 색 #rrggbb, 캣타워 방석) · spin(캣휠 각, 라디안) · edge(가장자리 그림자 흐림 px, DPR 반영) ·
 *    layer("back"·"front"·"all" — 상자만 두 겹, 나머지는 back 이 전부·front 는 없음) · slotW(칸 폭, 칸 맞춤) · shadow(바닥 그림자 색)
 */
export function drawFurniture(g, kind, x, bottom, S, o = {}) {
  if (!FURNITURE_ART[kind]) return;
  const { u, w } = furnitureBox(kind, S, o.slotW), layer = o.layer || "all", edge = o.edge ?? 4;
  const back = layer !== "front", front = layer !== "back";
  if (back && o.shadow !== null) { // 고양이와 같은 바닥 그림자
    g.save(); g.globalAlpha = 0.5; g.fillStyle = o.shadow || "rgba(20, 14, 24, 0.18)";
    g.beginPath(); g.ellipse(x, bottom + S, w * 0.48, 2.6 * S, 0, 0, Math.PI * 2); g.fill(); g.restore();
  }
  if (kind === "box") {
    if (back) drawShape(g, { v: 1, parts: BOX_BACK }, x, bottom, u, edge);
    if (front) drawShape(g, { v: 1, parts: BOX_FRONT }, x, bottom, u, edge);
    return;
  }
  if (!back) return;
  if (kind === "lamp") drawShape(g, { v: 1, parts: LAMP_PARTS(!!o.on), ...(o.on ? { glow: "yellow" } : {}) }, x, bottom, u, edge);
  else if (kind === "cattower") {
    drawShape(g, { v: 1, parts: TOWER_PARTS }, x, bottom, u, edge);
    // 방석: 포인트 색(없으면 보라). 위 밝게·아래 살짝 어둡게 — 선물 그림과 같은 입체
    const c = rgb(/^#[0-9a-f]{6}$/i.test(o.accent || "") ? o.accent : "#a98ad8"), cx = x + TOWER_CUSHION.x * u, cy = bottom + TOWER_CUSHION.y * u;
    const ry = TOWER_CUSHION.ry * u, gr = g.createLinearGradient(0, cy - ry, 0, cy + ry);
    gr.addColorStop(0, `rgb(${mix(c, [255, 255, 255], 0.3)})`); gr.addColorStop(1, `rgb(${mix(c, [58, 44, 52], 0.18)})`);
    g.fillStyle = gr; g.beginPath(); g.ellipse(cx, cy, TOWER_CUSHION.rx * u, ry, 0, 0, Math.PI * 2); g.fill();
  } else if (kind === "wheel") {
    drawShape(g, { v: 1, parts: WHEEL_STILL }, x, bottom, u, edge);
    g.save(); g.translate(x, bottom + WHEEL_CY * u); g.rotate(o.spin || 0);
    drawShape(g, { v: 1, parts: WHEEL_SPIN }, 0, 0, u, 0);
    g.restore();
  } else if (kind === "sofa") drawShape(g, { v: 1, parts: SOFA_PARTS }, x, bottom, u, edge);
}

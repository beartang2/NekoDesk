/**
 * 꿈 말풍선(0.1.25, 사용자: 중간중간 자는 상태일 때 꿈을 꿀 수 있도록): 자는 고양이 머리 위에 작은 구름과 그리로 이어지는 점 둘,
 * 구름 안에 꿈 그림 하나. 그림은 네코 그림체 그대로 — 선물 모양(gift-shape)이나 가구 그림(furniture-art)을 작게 다시 쓴다.
 * 글자는 넣지 않는다(예시 글귀 없음). 꿈 내용·언제 뜨는지는 엔진(집사)이 정하고, 이 모듈은 그리기만 한다.
 * 움직임은 아주 느린 둥실(t)과 나타나기(k)뿐 — 잘 때 프레임(15fps)에서도 비용이 거의 없다.
 */
import { drawShape, shapeBounds } from "./gift-shape.js";
import { drawFurniture, furnitureBox } from "./furniture-art.js";

/** 구름 반지름(무대 배율 S 기준)과 아주 작은 무대에서의 하한(px) — 폰 세로 거실(S 0.35)에서도 그림이 보이게 */
const CLOUD_R = 26, CLOUD_MIN = 17;
/** 구름 둘레의 혹(가운데 기준 각·반지름 비) — 위가 볼록한 뭉게구름 */
const BUMPS = [[-2.45, 0.62], [-1.75, 0.72], [-1.05, 0.66], [-0.35, 0.7], [0.35, 0.64], [2.6, 0.55], [1.6, 0.5], [0.95, 0.55]];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = (u) => { const x = clamp(u, 0, 1); return x * x * (3 - 2 * x); };

/** 구름 자리(무대 px): 귀 끝(머리 가운데 위 약 30·S) 위로 띄우고, 바라보는 쪽으로 조금. 무대 위·옆 끝 안으로 민다 */
export function dreamCloud(hx, hy, S, { face = 1, W = Infinity, H = Infinity } = {}) {
  const r = Math.max(CLOUD_MIN, CLOUD_R * S);
  const cx = clamp(hx + face * (10 * S + r * 0.55), r * 1.35 + 4, W - r * 1.35 - 4), cy = clamp(hy - 44 * S - r * 1.1, r + 4, H - r - 4);
  return { cx, cy, r };
}

function cloudPath(g, cx, cy, r) {
  g.beginPath();
  g.ellipse(cx, cy, r * 1.3, r * 0.82, 0, 0, Math.PI * 2);
  for (const [a, k] of BUMPS) {
    const bx = cx + Math.cos(a) * r * 1.02, by = cy + Math.sin(a) * r * 0.62;
    g.moveTo(bx + r * k, by); g.arc(bx, by, r * k, 0, Math.PI * 2);
  }
}

/**
 * 꿈 말풍선을 그린다. hx·hy = 머리 가운데(무대 px), S = 무대 배율.
 * o: face(±1, 바라보는 쪽) · k(0~1 나타나기 — 점 하나, 점 둘, 구름 순, 사라질 땐 거꾸로) · t(초, 아주 느린 둥실; 동작 줄이기면 0) ·
 *    dark(다크 테마) · W·H(무대 크기, 구름을 안으로) · edge(가장자리 그림자 흐림 px, DPR 반영) ·
 *    content: { shape }(gift-shape 모양) 또는 { furniture: kind, accent }(가구 그림). 없으면 빈 구름
 */
export function drawDream(g, hx, hy, S, o = {}) {
  const k = clamp(o.k ?? 1, 0, 1);
  if (k <= 0) return;
  const face = o.face === -1 ? -1 : 1, t = o.t || 0, bob = Math.sin(t * 0.9) * 1.2 * S;
  const { cx, cy: cy0, r } = dreamCloud(hx, hy, S, { face, W: o.W, H: o.H }), cy = cy0 + bob;
  const fill = o.dark ? "#e6e0ee" : "#fffdf9", shade = o.dark ? "rgba(0, 0, 0, 0.4)" : "rgba(40, 28, 48, 0.24)";
  g.save();
  g.fillStyle = fill; g.shadowColor = shade; g.shadowBlur = Math.max(2, 4 * S); g.shadowOffsetY = Math.max(0.5, 1 * S);
  // 이어지는 점 둘: 귀 위 작은 점 → 큰 점 → 구름 아래
  const x0 = hx + face * 8 * S, y0 = hy - 36 * S, x1 = cx - face * r * 0.45, y1 = cy + r * 0.75;
  for (const [u, rr, at] of [[0.05, 0.09, 0], [0.5, 0.15, 0.22]]) {
    const a = ease((k - at) / 0.25);
    if (a <= 0) continue;
    g.globalAlpha = a; g.beginPath(); g.arc(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, Math.max(1.8, rr * r), 0, Math.PI * 2); g.fill();
  }
  const ck = ease((k - 0.45) / 0.55);
  if (ck > 0) {
    g.globalAlpha = ck;
    const sc = 0.7 + 0.3 * ck;
    g.translate(cx, cy); g.scale(sc, sc); g.translate(-cx, -cy);
    cloudPath(g, cx, cy, r); g.fill();
    g.shadowColor = "transparent";
    drawContent(g, cx, cy, r, o);
  }
  g.restore();
}

/** 구름 안 그림: 구름 가운데 칸(폭 1.6r·높이 1.2r)에 맞춰 */
function drawContent(g, cx, cy, r, o) {
  const c = o.content;
  if (!c) return;
  const bw = r * 1.6, bh = r * 1.2, edge = o.edge ?? 3;
  if (c.shape && Array.isArray(c.shape.parts)) {
    const b = shapeBounds(c.shape), u = Math.min(bw / b.w, bh / b.h);
    drawShape(g, c.shape, cx - ((b.x0 + b.x1) / 2) * u, cy + (b.h * u) / 2, u, edge);
  } else if (c.furniture) {
    const one = furnitureBox(c.furniture, 1);
    if (!one.w) return;
    const s = Math.min(bw / one.w, bh / one.h);
    drawFurniture(g, c.furniture, cx, cy + (one.h * s) / 2, s, { accent: c.accent, edge, shadow: null, layer: "all" });
  }
}

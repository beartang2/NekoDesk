/**
 * 놓아 둔 선물의 크기·자리 계산과 그리기(엔진 없이도). 엔진과 모니터별 선물 창이 같이 쓴다 — 계산이 같아야
 * 고양이가 다른 모니터로 건너가 엔진이 그 모니터 선물을 이어받을 때 선물이 튀지 않는다. 설계: docs/neko-gifts.md §4
 *
 * geom = { W, floorY, S }: 무대 폭(px)·바닥 y(px)·배율. 자리는 비율이다 — 바닥: u = 양끝 여백을 뺀 폭 비율,
 * 벽: u 와 v = 바닥 위 쓸 수 있는 높이 비율(0~1).
 */
import { validateShape, shapeBounds, shapeTop, drawShape } from "./gift-shape.js";
import { roomWindows, windowBox } from "./room-window.js";

export const DECOR_SIZE = 96;  // 한 변(S 단위). 32 → 64 → 96: 사용자가 두 번 키웠다(아직 작다). 배율 0.5~3 은 이 기준
export const WALL_GAP = 18;    // 바닥에서 이만큼(S) 넘게 띄워 놓으면 벽에 건다
/** 물건 크기(실제 크기를 모델이 고름). 큰 것도 고양이 몸(길이 약 100)보다 작게 */
export const SIZE_K = { small: 0.6, medium: 1, large: 1.45 };
export const sizeK = (size) => (Object.hasOwn(SIZE_K, size) ? SIZE_K[size] : 1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** 사용자 배율(선물함 슬라이더): 0.5~3(새 기본 기준 = 예전 크기의 1~6배), 이상한 값은 1 */
export const SCALE_MIN = 0.5, SCALE_MAX = 3;
export const clampScale = (s) => (typeof s === "number" && Number.isFinite(s) ? clamp(s, SCALE_MIN, SCALE_MAX) : 1);
/** 선 고양이 키(귀 끝까지, S 단위). 마당 상한의 기준 */
export const CAT_H = 100;
/**
 * 자리별 물건 높이 상한(px, 사용자 확정): 방(sidebar)은 방 높이의 80%, 거실(dock)은 띠 높이, 마당(screen)은 고양이 키의 3배.
 * g = { floorY, S }(floorY 는 무대 바닥 = 방·띠 높이쯤). 장소를 모르면 상한 없음
 *
 * 방은 방 높이로 고양이 크기가 정해져(S = floorY/240) 방 높이의 80% = 고양이 키의 1.92배다. 거실도 같은 고양이 대비로 묶는다 —
 * 띠 높이 전부(고양이 키 2.4배)까지 키우면 맥 방에서 보던 것보다 크고, 화면을 채운 폰 가로 거실에선 더 커 보였다(사용자).
 * 맥 거실·폰 세로 거실·폰 가로 모두 큰 선물은 고양이 키의 1.92배에서 멈춘다(띠가 그보다 낮으면 띠 높이)
 */
export const ROOM_CAP_CATS = (0.8 * 240) / CAT_H;
export function capPx(at, g) {
  if (at === "screen") return 3 * CAT_H * g.S;
  // 방: 방 높이의 80%, 그리고 고양이 키 1.92배(맥 방은 S = 바닥/240 이라 같은 값, 폰은 고양이와 같이 70% 로 — stage-scale)
  if (at === "sidebar") return Math.min(0.8 * g.floorY, ROOM_CAP_CATS * CAT_H * g.S);
  if (at === "dock") return Math.min(g.floorY, ROOM_CAP_CATS * CAT_H * g.S);
  return Infinity;
}
/**
 * 고양이보다 높은 거실(폰을 가로로 돌린 화면): 띠가 높아도 고양이는 S 1.4 에서 멈추고 선물도 고양이 대비로 같이 커져, 화면 폭에
 * 비해 세로 거실보다 1.4배쯤 커 보였다. 이런 거실에서는 선물을 고양이 대비 70% 로(사용자가 그림 두 장을 보고 골랐다).
 * 맥 거실·폰 세로 거실은 띠가 240 을 안 넘어 해당 없다
 */
export const TALL_DOCK_Y = 1.4 * 240;
export const TALL_DOCK_K = 0.7;
const tallK = (at, g) => (at === "dock" && g.floorY > TALL_DOCK_Y ? TALL_DOCK_K : 1);
/** 그릴 배율 k = 크기(소·중·대) × 사용자 배율(× 높은 거실 70%), 그 자리 상한(높이)까지. capped = 상한에 걸렸나(저장값은 그대로) */
export function decorK(shape, size, scale, at, g) {
  const k0 = sizeK(size) * clampScale(scale) * tallK(at, g), h1 = decorDims(shape, 1, g.S).h, kMax = capPx(at, g) / Math.max(1e-6, h1);
  return k0 > kMax ? { k: kMax, capped: true } : { k: k0, capped: false };
}

/** 물건 한 개의 크기(px)와 그리기 배율 u */
export function decorDims(shape, k, S) {
  const bd = shapeBounds(shape), u = (DECOR_SIZE * k * S) / Math.max(bd.w, bd.h);
  return { bd, u, w: bd.w * u, h: bd.h * u };
}
export const decorM = (S) => 16 * S;
/**
 * 가구 칸(docs/neko-furniture.md §4·§6): 방(sidebar) 2칸·거실(dock) 4칸, 마당은 없다. 무대 폭을 칸 수로 똑같이 나눈 자리 —
 * [{ x: 칸 가운데, w: 칸 폭 }](무대 px). 가구는 칸 바닥 가운데에 놓이고, 칸 폭의 90% 를 넘으면 줄여 그린다(furniture-art)
 */
export const FURNITURE_SLOTS = { sidebar: 2, dock: 4 };
export function furnitureSlots(at, W) {
  const n = FURNITURE_SLOTS[at] ?? 0, w = n ? W / n : 0;
  return Array.from({ length: n }, (_, i) => ({ x: (i + 0.5) * w, w }));
}
/** 벽 v = 1 이면 물건 위가 무대 위에서 10 아래 */
export const wallSpan = (h, g) => Math.max(1, g.floorY - h - 10 * g.S);
/**
 * 자리(면·비율) → 그릴 자리(가운데 x, 바닥 y). 방·거실 벽에 건 것(d.at, 폭 w 를 알 때)은 날씨 창문과 겹치면 비켜 건다(clearWindows) —
 * 받은 자리·창 크기가 바뀐 때도 같은 규칙이라 그릴 때 한다. 끌어 놓을 땐 비킨 자리를 저장한다(hungSpot). 무대 높이는 바닥 + 6(엔진 resize 와 같다)
 */
export function decorAt(d, h, g, w = 0) {
  const m = decorM(g.S), x = m + d.u * Math.max(0, g.W - 2 * m);
  if (d.surface === "furniture") { // 가구 윗면 위(탁자): 그 면이 무대에 없으면 바로 아래 바닥(u)
    const t = topOf(g, d.fid, d.i);
    if (t) { const half = Math.min(w / 2, (t.x1 - t.x0) / 2); return [clamp(t.x0 + (d.fu ?? 0.5) * (t.x1 - t.x0), t.x0 + half, t.x1 - half), t.y]; }
  }
  if (d.surface !== "wall") return [x, g.floorY];
  const bottom = g.floorY - (d.v ?? 0.5) * wallSpan(h, g);
  return w > 0 ? clearWindows(x, bottom, w, h, roomWindows(d.at, g.W, g.floorY + 6).map(windowBox), g) : [x, bottom];
}
/**
 * 벽에 건 것(가운데 x, 바닥 bottom, w×h)이 창(그린 테두리 칸)과 겹치면 위·아래·왼쪽·오른쪽 중 가장 조금 움직여 안 겹치는 쪽으로
 * 민다(사용자: 창 근처에 걸면 아래로 꺼졌다). 민 자리가 벽 밖(무대 위 10·S·바닥선·무대 옆 끝)이거나 다른 창과 겹치면 다음으로
 * 가까운 쪽, 넷 다 안 되면 창턱 아래(바닥선까지). 테두리에 맞닿는 건 겹침이 아니다(0.5px 여유 — 비율로 저장했다 읽어도 같게)
 */
function clearWindows(x, bottom, w, h, wins, g) {
  const E = 0.5, m = decorM(g.S);
  const hit = (cx, b) => wins.find((r) => cx + w / 2 > r.x0 + E && cx - w / 2 < r.x1 - E && b > r.y0 + E && b - h < r.y1 - E);
  const r = hit(x, bottom);
  if (!r) return [x, bottom];
  const fits = ([cx, b]) => cx >= Math.max(m, w / 2) - E && cx <= Math.min(g.W - m, g.W - w / 2) + E && b - h >= 10 * g.S - E && b <= g.floorY + E && !hit(cx, b);
  const ways = [[r.x0 - w / 2, bottom], [r.x1 + w / 2, bottom], [x, r.y0], [x, r.y1 + h]];
  const best = ways.sort((a, b) => Math.abs(a[0] - x) + Math.abs(a[1] - bottom) - Math.abs(b[0] - x) - Math.abs(b[1] - bottom)).find(fits);
  return best ?? [x, Math.min(g.floorY, r.y1 + h)];
}
/**
 * 끌어 놓은 벽 자리를 그려질 자리(창을 비킨 자리)의 비율로 — 저장해 맥·폰이 같은 자리에서 시작한다. 벽이 아니면 그대로.
 * at = 장소(방·거실만 창이 있다), w·h = 그릴 칸
 */
export function hungSpot(spot, h, g, w, at) {
  if (spot.surface !== "wall") return spot;
  const [x, bottom] = decorAt({ ...spot, at }, h, g, w), m = decorM(g.S);
  return { surface: "wall", u: clamp((x - m) / Math.max(0, g.W - 2 * m) || 0, 0, 1), v: clamp((g.floorY - bottom) / wallSpan(h, g), 0, 1) };
}
/**
 * 물건을 얹는 가구 윗면(사용자: 탁자 위에 물건을 둔다). g.tops = [{ fid(가구 id), i(면 번호), x0, x1, y }](무대 px, 면 위가 y).
 * 엔진은 놓인 가구의 hold 면에서, 빈 방·선물함 끌어 놓기는 가구 저장 값에서 같은 식으로 만든다(furnitureSurfaces)
 */
const topOf = (g, fid, i) => (g.tops || []).find((t) => t.fid === fid && t.i === i) || null;
/** 끌어 놓을 때 물건 바닥이 윗면에서 이만큼(S) 안이면 그 위에 얹는다 */
export const ON_TOP_SNAP = 22;
/** 끄는 중인 물건(높이 h)을 무대 안에 묶는다: 양끝 여백 안, 바닥 아래로는 안 내려가고 무대 위로도 안 나간다 */
/**
 * 던진 물건이 바닥으로 떨어진다 — 고양이를 던졌을 때와 같은 중력·최고 속도(엔진 GRAV·FALL_VMAX), 바닥에서 FALL_BOUNCE 만큼 튕긴다.
 * 액자 아닌 물건을 벽 쪽에 놓으면 이걸로 떨어뜨린다(사용자, 0.1.24). 엔진과 빈 방 그림(RoomGifts)이 같이 쓴다.
 * f = { x, bottom, vx, vy }(무대 px, px/초)를 고친다. 바닥에 내려앉아 멈추면 true
 */
export const FALL_G = 2050, FALL_VMAX = 1500, FALL_BOUNCE = 0.35;
export function fallStep(f, dt, g) {
  const S = g.S, m = decorM(S);
  f.vy = Math.min(f.vy + FALL_G * S * dt, FALL_VMAX * S);
  f.x += f.vx * dt; f.bottom += f.vy * dt;
  if (f.x < m) { f.x = m; f.vx = Math.abs(f.vx) * 0.5; } else if (f.x > g.W - m) { f.x = g.W - m; f.vx = -Math.abs(f.vx) * 0.5; }
  if (f.bottom >= g.floorY) {
    f.bottom = g.floorY;
    if (f.vy < 140 * S) { f.vy = 0; return true; }
    f.vy = -f.vy * FALL_BOUNCE; f.vx *= 0.75;
  }
  return false;
}
/**
 * 바닥에서 굴러간다(굴리기·던지기): 감쇠 1.6, 무대 끝에서 반만큼 튕기고 굴러간 만큼 돈다. 엔진과 빈 방 그림이 같이 쓴다.
 * f = { x(물건 가운데), vx, rot } 를 고친다. h = 물건 높이(굴림 반지름 h/2). 서면 true
 */
export function rollStep(f, dt, g, h) {
  const m = decorM(g.S) + h / 2;
  f.x += f.vx * dt; f.vx *= Math.exp(-dt * 1.6); f.rot = (f.rot || 0) + (f.vx / (h / 2)) * dt;
  if (f.x < m) { f.x = m; f.vx = Math.abs(f.vx) * 0.5; } else if (f.x > g.W - m) { f.x = g.W - m; f.vx = -Math.abs(f.vx) * 0.5; }
  if (Math.abs(f.vx) < 8 * g.S) { f.vx = 0; return true; }
  return false;
}
/**
 * 놀다 멈춘 각도(라디안: 던지기·굴리기, 떨어져 누운 액자 ±π/2) — 놓인 자리(placed.rot)에 저장·동기화하는 값.
 * (−π, π] 로 접고 0.01 로 반올림한다. 이상한 값(손으로 고친 DB·다른 버전)은 0(똑바로)
 */
export function normRot(r) {
  if (typeof r !== "number" || !Number.isFinite(r)) return 0;
  return Math.round((r - 2 * Math.PI * Math.round(r / (2 * Math.PI))) * 100) / 100 || 0;
}
/**
 * 던지기(사용자: 바닥 물건을 흔들다 던지면 네코가 쫓아간다): 놓는 순간 이 빠르기(무대 px/초 ÷ S)를 넘으면 그 속도로 날아간다 —
 * 날다 떨어져 튕기고(fallStep) 바닥에선 굴러가 선다(rollStep). 느리면 지금처럼 그 자리에 놓는다. 액자는 안 던진다
 */
export const THROW_MIN = 520, THROW_MAX = 1400, THROW_STILL = 90; // THROW_STILL: 놓기 전 이만큼(ms) 손이 멈춰 있었으면 던지지 않는다
/** 던지는 속도: THROW_MAX 로 묶고, 위로는 물건 꼭대기가 무대 위(10·S)를 안 넘을 만큼만 — 무대 밖으로 사라졌다 떨어지지 않게 */
export function throwVel(vx, vy, bottom, h, g) {
  const lim = THROW_MAX * g.S, up = Math.sqrt(2 * FALL_G * g.S * Math.max(0, bottom - h - 10 * g.S));
  return [clamp(vx, -lim, lim), clamp(vy, -Math.min(lim, up), lim)];
}
export const clampDrag = (h, g, x, bottom) => [clamp(x, decorM(g.S), g.W - decorM(g.S)), clamp(bottom, h + 10 * g.S, g.floorY)];
/** 끌어 들어 올린 모양: 조금 크고 가장자리 그림자가 더 흐리다. 바닥 가까이면 바닥 그림자 */
const LIFT = 1.08;
const liftedOnFloor = (bottom, g) => g.floorY - bottom < WALL_GAP * g.S;
/** 무대의 한 점(물건 가운데 x, 바닥 y) → 자리(면·비율). 바닥 가까이면 바닥, 높이 띄우면 벽 */
export function spotOf(x, bottom, h, g) {
  const m = decorM(g.S), u = clamp((x - m) / Math.max(1, g.W - 2 * m), 0, 1);
  // 가구 윗면 위: u 는 바로 아래 바닥 자리(모르는 자리를 바닥으로 읽는 옛 버전은 거기에 둔다)
  for (const t of g.tops || []) {
    if (x >= t.x0 && x <= t.x1 && Math.abs(bottom - t.y) < ON_TOP_SNAP * g.S) return { surface: "furniture", fid: t.fid, i: t.i, fu: clamp((x - t.x0) / Math.max(1, t.x1 - t.x0), 0, 1), u };
  }
  return g.floorY - bottom < WALL_GAP * g.S ? { surface: "floor", u } : { surface: "wall", u, v: clamp((g.floorY - bottom) / wallSpan(h, g), 0, 1) };
}

/**
 * 물건 하나를 g 에 그린다. L = { bd, u, w, h, x, bottom, onFloor }(decorDims + 자리).
 * o: shadow 색, sc 뿅 배율 [x, y], rot 구르기, wob 흔들림, edge 가장자리 그림자(px), dark 아님
 */
export function paintDecor(g, shape, L, geom, o = {}) {
  const { bd, u, h, x, bottom, onFloor } = L, S = geom.S, sc = o.sc || [1, 1];
  if (onFloor) { // 고양이와 같은 바닥 그림자(가구 윗면 위면 그 면에)
    g.save(); g.globalAlpha = 0.5; g.fillStyle = o.shadow || "rgba(20, 14, 24, 0.18)";
    g.beginPath(); g.ellipse(x, (L.shadowY ?? geom.floorY) + 1 * S, L.w * 0.5, 2.6 * S, 0, 0, Math.PI * 2); g.fill(); g.restore();
  }
  if (sc[0] <= 0.002 || sc[1] <= 0.002) return;
  g.save();
  g.translate(x, bottom); g.scale(sc[0], sc[1]); g.translate(-x, -bottom);
  // 굴러가면 가운데를 축으로 돌고(rot), 앞발로 톡 치면 바닥을 축으로 흔들린다(wob)
  g.save();
  g.translate(x, bottom - h / 2); g.rotate(o.rot || 0); g.translate(-x, -(bottom - h / 2));
  g.translate(x, bottom); g.rotate(o.wob || 0); g.translate(-x, -bottom);
  // 바닥에 누운 액자(lie): 칸(L.w·L.h)은 가로세로가 바뀐 것 — 그림은 칸 가운데에 두고 돌린다(o.rot ±90°)
  drawShape(g, shape, x - ((bd.x0 + bd.x1) / 2) * u, L.lie ? bottom - h / 2 + L.h0 / 2 : bottom, u, o.edge ?? 4);
  g.restore();
  // 벽에 건 것: 그린 모양의 맨 위 가장자리에 작은 압정. h(칸)는 회전한 네모·타원을 넉넉히 잡아 실제보다 높다.
  // pin false = 벽 높이로 들었지만 걸리지 않는 것(방·거실의 액자 아닌 물건 — 놓으면 떨어진다, 0.1.24)
  if (!onFloor && L.pin !== false) {
    const top = bottom + shapeTop(shape) * u;
    g.fillStyle = "#8f8a86"; g.beginPath(); g.arc(x, top + 1.5 * S, 1.8 * S, 0, Math.PI * 2); g.fill();
    g.fillStyle = "rgba(255,255,255,0.6)"; g.beginPath(); g.arc(x - 0.5 * S, top + 1 * S, 0.7 * S, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}

/** 놓인 물건(setDecor 와 같은 모양) → 그릴 자리 목록. 모양이 이상하면 검사에서 기본 모양으로 바뀐다.
 *  drag = { id, x, bottom }: 끄는 물건은 그 자리(clampDrag 로 묶은 값)에 들어 올린 모양으로 */
function layoutAll(items, geom, drag) {
  return (items || []).filter((d) => d && d.id != null && Number.isFinite(d.u)).map((d) => {
    const shape = validateShape(d.shape), dims = decorDims(shape, decorK(shape, d.size, d.scale, d.at, geom).k, geom.S), id = String(d.id);
    if (drag && String(drag.id) === id) {
      const [x, bottom] = clampDrag(dims.h, geom, drag.x, drag.bottom);
      // 던져 날아가거나 굴러가는 중(fly)은 들어 올린 모양 없이 돈다(rot). 압정은 벽에 걸리는 것만(액자, 마당은 다)
      return { id, shape, L: { ...dims, x, bottom, onFloor: liftedOnFloor(bottom, geom), pin: !!d.frame || d.at === "screen" }, lifted: !drag.fly, fly: !!drag.fly, rot: drag.rot || 0 };
    }
    const on = d.surface === "furniture" && topOf(geom, d.fid, d.i); // 가구 윗면 위(그 면이 있을 때만, 없으면 바닥)
    // 바닥의 액자는 떨어진 것: 옆으로 눕는다(사용자가 다시 벽에 걸 때까지) — 칸 가로세로를 바꾸고 떨어진 쪽(rot 부호)으로 90° 돌려 그린다
    if (d.frame && !on && d.surface !== "wall") {
      const [x, bottom] = decorAt({ surface: "floor", u: clamp(d.u, 0, 1) }, dims.w, geom, dims.h);
      return { id, shape, L: { ...dims, w: dims.h, h: dims.w, h0: dims.h, lie: true, x, bottom, onFloor: true }, wall: false, rot: (Math.sign(normRot(d.rot)) || 1) * (Math.PI / 2) };
    }
    const spot = on ? { surface: "furniture", fid: d.fid, i: d.i, fu: d.fu, u: clamp(d.u, 0, 1) }
      : { surface: d.surface === "wall" ? "wall" : "floor", u: clamp(d.u, 0, 1), v: clamp(Number.isFinite(d.v) ? d.v : 0.5, 0, 1), at: d.at };
    const [x, bottom] = decorAt(spot, dims.h, geom, dims.w);
    // 놀다 멈춘 각도(placed.rot)로 그린다 — 엔진 무대와 같게. 벽에 건 것은 똑바로
    return { id, shape, L: { ...dims, x, bottom, onFloor: spot.surface !== "wall", ...(on ? { shadowY: bottom } : {}) }, wall: spot.surface === "wall", rot: spot.surface === "wall" ? 0 : normRot(d.rot) };
  });
}
const geomOf = ({ W, floorY, scale, tops }) => ({ W, floorY, S: clamp(Number.isFinite(scale) ? scale : 1, 0.35, 1.4), tops });

/**
 * 엔진 없이 선물만 그린다(모니터별 선물 창). 캔버스를 W×H(css px) × dpr 로 맞추고 다 지운 뒤 그린다.
 * 멈춘 모양이다(뿅·흔들림·구르기 없음) — 바뀔 때만 부르면 된다. scale 은 엔진 setScale 과 같은 값.
 * drag = { id, x, bottom }: 사용자가 끄는 물건(물건 가운데 x, 바닥 y). 엔진 끌기와 같게 묶고 들어 올린 모양으로 맨 위에.
 * only = "wall": 벽에 건 것만(끄는 것 빼고) · "rest": 그 밖 — 벽 선물을 가구 밑 캔버스에 따로 그릴 때(빈 방, 사용자: 가구 위에 액자가 걸리지 않게)
 */
export function drawDecor(canvas, items, { W, H, floorY, scale, tops, dpr = 1, dark = false, drag = null, only = null }) {
  const geom = geomOf({ W, floorY, scale, tops }), bw = Math.round(W * dpr), bh = Math.round(H * dpr);
  if (canvas.width !== bw || canvas.height !== bh) { canvas.width = bw; canvas.height = bh; }
  const g = canvas.getContext("2d");
  g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, bw, bh);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const shadow = dark ? "rgba(0, 0, 0, 0.32)" : "rgba(20, 14, 24, 0.18)";
  const all = layoutAll(items, geom, drag).filter((o) => !only || (!!o.wall && !o.lifted && !o.fly) === (only === "wall"));
  for (const it of [...all.filter((o) => !o.lifted && !o.fly), ...all.filter((o) => o.lifted || o.fly)]) {
    paintDecor(g, it.shape, it.L, geom, it.lifted ? { shadow, sc: [LIFT, LIFT], edge: 7 * dpr } : { shadow, edge: 4 * dpr, rot: it.rot });
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
  const geom = geomOf(view), it = layoutAll(items, geom, { id: String(id), x, bottom }).find((o) => o.id === String(id)); // 든 모양(누운 액자도 세운 칸)
  if (!it) return null;
  const [cx, cb] = clampDrag(it.L.h, geom, x, bottom), at = items.find((d) => String(d.id) === String(id))?.at;
  return { x: cx, bottom: cb, spot: hungSpot(spotOf(cx, cb, it.L.h, geom), it.L.h, geom, it.L.w, at) }; // 벽이면 창을 비킨 자리
}

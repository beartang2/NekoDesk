/**
 * 네코 자리(방·거실 무대)의 크기 배율 S 한 곳. 엔진 resize 의 높이 모드 식(min(바닥/240, 폭/250), 0.35~1.4)에 기기 배율 K 를 곱한다.
 * 폰은 K = 0.7: 고양이·창문·선물을 같은 비율로 줄여 거실이 넓어 보이게(사용자, 0.1.24). 맥은 1 — 창을 키우면 된다.
 * 방(sidebar)만은 기기와 상관없이 ROOM_K — 아래.
 * 맥 거실은 기본 높이(DOCK_GROW_H)부터 크기를 멈춘다 — 아래 sizeH.
 * 엔진은 이 식을 따로 갖고 있어 호스트(nekoHost)가 setScale(stageS) 로 넘긴다. 방 그림·창문·가구·선물함 안내가 이걸 쓴다
 */
export const PHONE_K = 0.7;
/**
 * 방(sidebar)의 배율: 맥·폰 같은 값(사용자, 0.1.33). 고양이 키가 방 높이의 33% 가 된다(기본 높이 200 에서 66px) —
 * 맥 방(전 40%, 81px)은 넓어 보이게 줄고, 폰 방(전 28%, 57px)은 덜 넓어 보이게 커진다. 거실·마당은 기기 배율 그대로
 */
export const ROOM_K = 0.82;
let K = 1;
/** 기기 배율(폰이면 PHONE_K). 앱이 켤 때 한 번 */
export function setStageK(k) { K = Number.isFinite(k) && k > 0 ? k : 1; }
/** 그 장소에 곱하는 배율: 방은 ROOM_K, 나머지(거실·장소 없음)는 기기 배율 */
export function stageK(place) { return place === "sidebar" ? ROOM_K : K; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/**
 * 맥 거실은 이 높이(기본 높이, nekoStore DOCK_H.def)까지만 고양이·창문·선물·가구가 커진다(사용자, 0.1.24). 띠를 더 키우면 벽만 넓어져
 * 가장 크게(240) 했을 때 고양이 키가 거실 높이의 0.28 — 폰 거실(세로 0.29, 가로 0.26)과 같은 비율이다. 폰은 K 가 이 비율을 이미 맞춘다
 */
export const DOCK_GROW_H = 170;
/** 크기를 잴 때 쓰는 무대 높이: 맥 거실은 DOCK_GROW_H 까지만. 방·폰은 그대로(자리 y 는 실제 높이로 잰다) */
export function sizeH(place, H) { return place === "dock" && K === 1 ? Math.min(H, DOCK_GROW_H) : H; }
/** 무대 폭 W·바닥 y(px)·장소 → S. 엔진 setScale 과 같게 0.35 아래로는 안 줄인다 */
export function stageS(W, floorY, place) {
  const f = sizeH(place, floorY + 6) - 6;
  return Math.max(0.35, clamp(Math.min(f / 240, W / 250), 0.35, 1.4) * stageK(place));
}

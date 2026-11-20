/**
 * 네코 자리(방·거실 무대)의 크기 배율 S 한 곳. 엔진 resize 의 높이 모드 식(min(바닥/240, 폭/250), 0.35~1.4)에 기기 배율 K 를 곱한다.
 * 폰은 K = 0.7: 고양이·창문·선물을 같은 비율로 줄여 거실이 넓어 보이게(사용자, 0.1.24). 맥은 1 — 창을 키우면 된다.
 * 엔진은 이 식을 따로 갖고 있어, 폰은 호스트(nekoHost)가 setScale(stageS) 로 넘긴다. 방 그림·창문·선물함 안내가 이걸 쓴다
 */
export const PHONE_K = 0.7;
let K = 1;
/** 기기 배율(폰이면 PHONE_K). 앱이 켤 때 한 번 */
export function setStageK(k) { K = Number.isFinite(k) && k > 0 ? k : 1; }
export function stageK() { return K; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
/** 무대 폭 W·바닥 y(px) → S. 엔진 setScale 과 같게 0.35 아래로는 안 줄인다 */
export function stageS(W, floorY) {
  return Math.max(0.35, clamp(Math.min(floorY / 240, W / 250), 0.35, 1.4) * K);
}

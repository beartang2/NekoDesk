/**
 * 네코 무대에서 고양이나 놓아 둔 선물을 잡은 동안 html[data-holding]. 폰의 가장자리 손짓(lib/phone.ts 대화 목록·설정 끌기)이
 * 이걸 보면 시작하지 않는다 — 가장자리 가까운 선물을 잡고 좌우로 옮기면 대화 목록이 열렸다. 엔진 무대는 엔진의 hold 사건으로
 * (nekoHost), 빈 방의 선물(RoomGifts)은 직접 건다
 */
export function setHolding(on: boolean): void {
  const el = document.documentElement;
  if (on) el.dataset.holding = "1";
  else delete el.dataset.holding;
}

/**
 * 방·거실 벽의 날씨 창문 자리. 화면(WeatherWindow)과 엔진('창밖 구경' 활동이 창 앞으로 갈 때)이 같이 읽는다.
 * W·H = 네코 자리(무대) 크기(css px), 결과도 무대 px. 마당엔 창문이 없다.
 *
 * - 방(sidebar): 왼쪽에서 1/4 지점에 세로로 긴 창 하나. 벽(바닥 이음매 위) 안에서 위쪽에
 * - 거실(dock): 높이가 낮아 가로로 긴 창 두 개. 왼쪽 1/4·오른쪽 1/4 지점(가운데는 비워 둔다)
 */
/** 창 칸 바깥으로 그리는 여백: 커튼 봉·커튼이 옆과 위로(PAD), 창턱이 아래로(SILL) 나온다. 벽에 건 선물이 피할 때도 쓴다 */
export const WINDOW_PAD = 7;
export const WINDOW_SILL = 6;

export function roomWindows(place, W, H) {
  if (!(W > 0 && H > 0) || (place !== "sidebar" && place !== "dock")) return [];
  const floorY = H - 6; // 엔진 resize 와 같다(투명 무대, 바닥은 아래에서 6px)
  const S = Math.min(1.4, Math.max(0.35, Math.min(floorY / 240, W / 250)));
  const seam = floorY - 18 * S; // 벽과 바닥이 만나는 줄
  if (place === "sidebar") {
    const h = Math.round(Math.min(seam * 0.46, 120)), w = Math.round(h * 0.62), y = Math.round(seam * 0.14);
    return [{ x: Math.round(W * 0.25 - w / 2), y, w, h }];
  }
  // 거실 높이는 보통 120~240 이고 그때 창 높이는 72 에서 멈춘다(높이 240 에서 30%). 그보다 높은 거실(폰을 가로로 돌린
  // 화면, 높이 375 남짓)에서는 그 30% 를 그대로 이어 가 창이 거실과 같이 커진다 — 72 에 묶어 두면 벽에 비해 작았다.
  // 폭도 창 모양(2.6:1)에 가깝게 남도록 조금 더 내준다. 높이 240 까지는 전과 똑같다.
  const tall = H > 240;
  const h = Math.round(tall ? H * 0.3 : Math.min(H * 0.4, 72));
  const w = Math.round(Math.min(W * (tall ? 0.38 : 0.3), h * 2.6)), y = Math.round(H * 0.12);
  return [0.25, 0.75].map((k) => ({ x: Math.round(W * k - w / 2), y, w, h }));
}

/** 창문 하나(거실이면 왼쪽 것). 없으면 null — 엔진의 '창밖 구경'이 이 앞으로 간다 */
export function roomWindow(place, W, H) {
  return roomWindows(place, W, H)[0] ?? null;
}

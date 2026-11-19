/**
 * 방·거실 벽의 날씨 창문 자리. 화면(WeatherWindow)과 엔진('창밖 구경' 활동이 창 앞으로 갈 때)이 같이 읽는다.
 * W·H = 네코 자리(무대) 크기(css px), 결과도 무대 px. 마당엔 창문이 없다.
 *
 * - 방(sidebar): 왼쪽에서 1/4 지점에 세로로 긴 창 하나. 벽(바닥 이음매 위) 안에서 위쪽에
 * - 거실(dock): 높이가 낮아 가로로 긴 창 두 개. 왼쪽 1/4·오른쪽 1/4 지점(가운데는 비워 둔다)
 */
export function roomWindows(place, W, H) {
  if (!(W > 0 && H > 0) || (place !== "sidebar" && place !== "dock")) return [];
  const floorY = H - 6; // 엔진 resize 와 같다(투명 무대, 바닥은 아래에서 6px)
  const S = Math.min(1.4, Math.max(0.35, Math.min(floorY / 240, W / 250)));
  const seam = floorY - 18 * S; // 벽과 바닥이 만나는 줄
  if (place === "sidebar") {
    const h = Math.round(Math.min(seam * 0.46, 120)), w = Math.round(h * 0.62), y = Math.round(seam * 0.14);
    return [{ x: Math.round(W * 0.25 - w / 2), y, w, h }];
  }
  const h = Math.round(Math.min(H * 0.4, 72)), w = Math.round(Math.min(W * 0.3, h * 2.6)), y = Math.round(H * 0.12);
  return [0.25, 0.75].map((k) => ({ x: Math.round(W * k - w / 2), y, w, h }));
}

/** 창문 하나(거실이면 왼쪽 것). 없으면 null — 엔진의 '창밖 구경'이 이 앞으로 간다 */
export function roomWindow(place, W, H) {
  return roomWindows(place, W, H)[0] ?? null;
}

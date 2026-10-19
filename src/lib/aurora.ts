/**
 * 오로라 색: 포인트 색에서 채도·색상만 조금씩 바꾼 색들. 자리(0~1)를 따라 물결치듯 서서히 바뀌어
 * 이웃끼리는 비슷하고, 부를 때마다 굽이 자리가 달라져 배치가 매번 다르다. 밝기는 포인트 색 그대로라
 * 어느 색도 튀지 않는다. CSS 에선 oklch(from var(--accent) l calc(c * chroma) calc(h + hue)) 로 쓴다.
 * 캡처 막의 가장자리 빛(edge-flow.ts)과 채팅 위 오로라가 같이 쓴다.
 */

export interface Tint {
  /** 채도 배수(0.7~1.3). */
  chroma: number;
  /** 색상환에서 돌리는 각도(-50~50°, 단위 없는 숫자). */
  hue: number;
}

/**
 * 자리(0~1)를 따라 부드럽게 오르내리는 물결(0~1). 한 바퀴에 두세 번 굽이치고, 부를 때마다 굽이
 * 자리가 달라진다.
 */
export function wave(): (at: number) => number {
  const a = Math.random() * Math.PI * 2;
  const b = Math.random() * Math.PI * 2;
  return (u) => 0.5 + 0.3 * Math.sin(Math.PI * 2 * 2 * u + a) + 0.2 * Math.sin(Math.PI * 2 * 3 * u + b);
}

/** 이번 배치의 오로라 색을 자리(0~1)마다 돌려주는 함수. */
export function auroraTints(): (at: number) => Tint {
  const hue = wave();
  const chroma = wave();
  return (u) => ({ chroma: 0.7 + chroma(u) * 0.6, hue: (hue(u) - 0.5) * 100 });
}

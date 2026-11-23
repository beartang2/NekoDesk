/**
 * 넓은 표(가로로 밀리는 .table-wrapper) 위의 휠·트랙패드(사용자: 표 위에서 위아래 스크롤이 안 먹는다).
 *
 * 맥 WebKit 은 손짓 하나를 처음 받은 스크롤 상자에 묶는다. 세로로 밀어도 첫 움직임이 옆으로 조금 더 크면 손짓 전체가 표에 묶여
 * 세로 몫이 버려졌다(표 끝이라 옆으로도 못 가면 overscroll-behavior-x: contain 때문에 그대로 묶였다). 그래서 넓은 표 위에선
 * 휠을 직접 나눈다: 손짓마다(200ms 넘게 쉬면 새 손짓) 처음 8px 를 모아 축을 정하고(옆이 세로의 1.5배를 넘어야 옆 — 세로로 미는 손의
 * 첫 떨림에 묶이지 않게), 모은 만큼을 그 축에 한꺼번에 준 뒤 세로면 대화 목록(세로로 밀리는 조상)을, 옆이면 표를 민다.
 * 좁은 표도 같다 — 듣는 손이 붙으면 WebKit 이 좁은 표에도 옆으로 시작한 손짓을 묶었다(옆 몫은 갈 데가 없어 버린다).
 * 핀치 확대(ctrl)는 그대로. 손가락(터치)은 브라우저가 축을 잘 나눠 손대지 않는다
 */
const GAP_MS = 200;
const LOCK_PX = 8;

/** 세로로 밀리는 가장 가까운 조상(없으면 문서) */
function scrollParentY(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** 표 감싸개에 휠 나누기를 건다. 떼는 함수를 돌려준다 */
export function tableWheel(wrap: HTMLElement): () => void {
  let last = -Infinity, axis: "x" | "y" | null = null, sx = 0, sy = 0;
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) return;
    if (e.timeStamp - last > GAP_MS) { axis = null; sx = 0; sy = 0; }
    last = e.timeStamp;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? wrap.clientHeight : 1;
    let dx = e.deltaX * k, dy = e.deltaY * k;
    if (!axis) { // 축을 정하기 전엔 모아 둔다(마우스 휠 한 칸은 바로 넘는다)
      sx += dx; sy += dy;
      if (Math.abs(sx) + Math.abs(sy) < LOCK_PX) return;
      axis = Math.abs(sx) > 1.5 * Math.abs(sy) ? "x" : "y"; dx = sx; dy = sy;
    }
    if (axis === "x") wrap.scrollLeft += dx;
    else scrollParentY(wrap).scrollTop += dy;
  };
  wrap.addEventListener("wheel", onWheel, { passive: false });
  return () => wrap.removeEventListener("wheel", onWheel);
}

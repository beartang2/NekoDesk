import { useRef, type MouseEvent } from "react";

/**
 * 바탕을 눌러 닫기. 누른 곳과 뗀 곳이 둘 다 바탕일 때만 닫는다 — 안쪽 글칸에서 글을 끌어 고르다가
 * 바탕에서 손을 떼면 click 이 바탕에서 나서(누른 곳과 뗀 곳의 공통 조상) 그대로 닫혔다.
 * 돌려준 둘을 바탕 요소에 펼쳐 단다.
 */
export function useBackdropClose(onClose: () => void) {
  const pressed = useRef(false);
  return {
    onMouseDown: (e: MouseEvent) => {
      pressed.current = e.target === e.currentTarget;
    },
    onClick: (e: MouseEvent) => {
      if (pressed.current && e.target === e.currentTarget) onClose();
      pressed.current = false;
    },
  };
}

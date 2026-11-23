import { useLayoutEffect, useRef, useState, type MutableRefObject } from "react";

/**
 * 대화 목록의 '맨 아래로' 버튼. 보이고 숨는 건 목록이 bind 로 바로 알린다 — 이 버튼만 다시 그린다.
 * 예전엔 목록 상태 → App 상태로 올려, 나타나고 사라질 때마다(나타남·붙임·퇴장 끝 세 번) 앱 전체가 다시 그려져 스크롤이
 * 버벅였다(사용자). 같은 값은 여기서 거른다 — 스크롤마다 알려도 React 까지 안 간다.
 * 사라지는 애니메이션(App.css scroll-btn-out)이 끝날 때까지 붙여 둔다
 */
export function ScrollBottomButton({ bind, onClick }: { bind: MutableRefObject<(show: boolean) => void>; onClick: () => void }) {
  const [show, setShow] = useState(false);
  const [mounted, setMounted] = useState(false);
  const now = useRef(false);
  if (show && !mounted) setMounted(true);
  // 자식 레이아웃 효과가 부모(목록)보다 먼저 돈다 — 목록이 처음 그릴 때(보던 자리 되찾기) 알려도 받는다
  useLayoutEffect(() => {
    bind.current = (v) => { if (v !== now.current) { now.current = v; setShow(v); } };
    return () => { bind.current = () => {}; };
  }, [bind]);
  if (!mounted) return null;
  return (
    <button
      type="button"
      className="chat-scroll-btn"
      data-leaving={show ? undefined : ""}
      onAnimationEnd={() => { if (!show) setMounted(false); }}
      onClick={onClick}
      title="맨 아래로"
    >
      ↓
    </button>
  );
}

import { useLayoutEffect, useRef } from "react";
import { cleanShownText } from "../lib/replyTags";
import "./NekoSays.css";

/**
 * 네코가 먼저 건네는 한마디(쉬다 깬 뒤 첫마디, agent/neko-mind takeGreeting) 말풍선.
 *
 * - stage: 네코 머리 위. 매 프레임 머리(engine head)를 따라가고, 무대(부모 상자 — 마당은 창 = 모니터) 안쪽으로 밀어 밖으로 안 나간다.
 *   머리 위에 자리가 없으면 아래로 밀려 머리와 겹칠 수 있다(잘리는 것보다 낫다).
 * - top: 폰 세로 화면 — 채팅 화면 위쪽 가운데(네코 띠가 좁아서, 사용자). 부모(.main)가 자리를 준다.
 *
 * 긴 말은 낱말 단위로 줄바꿈하고 최대 높이를 넘으면 말풍선 안에서 스크롤한다(그때만 누르기를 받는다 — 평소엔 아래 고양이·채팅을 가리지 않게).
 * 글은 모델 태그를 떼고, 반쪽만 남은 글자(서로게이트)를 버린다 — 폰에서 글자가 깨져 보였다(사용자)
 */
export function NekoSays({ text, head, mode, fixed = false }: {
  text: string;
  /** 머리(무대 px — fixed 면 창 px). 없으면 그 자리에 둔다 */
  head?: () => { x: number; y: number; r: number } | null | undefined;
  mode: "stage" | "top";
  /** 창 기준(position: fixed, 마당 화면 창) */
  fixed?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const headRef = useRef(head);
  headRef.current = head; // 부모가 다시 그릴 때마다 새 함수가 와도 따라가기를 다시 시작하지 않게
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.toggle("neko-says--scroll", el.scrollHeight > el.clientHeight + 1);
    if (mode !== "stage") return;
    let raf = 0;
    const place = () => {
      const h = headRef.current?.(), box = fixed ? null : (el.offsetParent as HTMLElement | null);
      const W = box ? box.clientWidth : window.innerWidth, H = box ? box.clientHeight : window.innerHeight;
      if (h && W > 0) {
        const M = 6, bw = el.offsetWidth, bh = el.offsetHeight;
        const x = Math.min(Math.max(h.x - bw / 2, M), Math.max(M, W - bw - M));
        const y = Math.min(Math.max(h.y - h.r - 8 - bh, M), Math.max(M, H - bh - M));
        el.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
        el.style.visibility = "";
      }
      raf = requestAnimationFrame(place);
    };
    el.style.visibility = "hidden"; // 첫 자리를 잡기 전엔 숨긴다(왼쪽 위에서 튀어 오르지 않게)
    place();
    return () => cancelAnimationFrame(raf);
  }, [mode, fixed, text]);
  return (
    <div ref={ref} className={`neko-says neko-says--${mode}${fixed ? " neko-says--fixed" : ""}`} role="status">
      {shownSays(text)}
    </div>
  );
}

/** 말풍선 글: 모델 태그(감정·생각)를 떼고 반쪽 서로게이트를 버린다 */
export function shownSays(text: string): string {
  return cleanShownText(text).replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "").trim();
}

import { useLayoutEffect, type RefObject } from "react";

/**
 * 띄운 메뉴 버튼('정리'·'숨기기')이 틀 밖으로 나가면 안쪽으로 당긴다. 버튼은 style 의 left·top 으로 놓여 있어야 한다.
 * 틀은 offsetParent(네코 자리), fixed 면 창이다. 어느 쪽이든 창 밖으로는 안 나간다. key 가 바뀔 때마다(새로 열 때) 잰다.
 */
export function useKeepInside(ref: RefObject<HTMLElement | null>, key: unknown, pad = 2) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p = el.offsetParent?.getBoundingClientRect();
    const box = {
      left: Math.max(0, p?.left ?? 0) + pad,
      top: Math.max(0, p?.top ?? 0) + pad,
      right: Math.min(innerWidth, p?.right ?? innerWidth) - pad,
      bottom: Math.min(innerHeight, p?.bottom ?? innerHeight) - pad,
    };
    const r = el.getBoundingClientRect();
    const dx = r.left < box.left ? box.left - r.left : r.right > box.right ? box.right - r.right : 0;
    const dy = r.top < box.top ? box.top - r.top : r.bottom > box.bottom ? box.bottom - r.bottom : 0;
    if (dx) el.style.left = `${parseFloat(el.style.left) + dx}px`;
    if (dy) el.style.top = `${parseFloat(el.style.top) + dy}px`;
  }, [ref, key, pad]);
}

import { useEffect, type RefObject } from "react";

/**
 * 스크롤되는 목록을 살려 주는 두 가지 (reactbits 의 AnimatedList).
 *
 * 1. 가장자리 페이드 — 위아래가 잘려 있다는 걸 그림자처럼 알려준다. 항상 깔아두면
 *    맨 위에서도 첫 줄이 흐려 보이므로, 실제로 가려진 만큼만 진하게 한다.
 * 2. 등장 — 화면에 들어온 줄만 제자리로 올라온다. 목록을 훑을 때 줄이 "놓이는" 결.
 *
 * 원본은 motion/react 의 useInView 를 쓴다. 여기서는 IntersectionObserver 와
 * CSS 변수만으로 같은 일을 한다.
 */

/** 가려진 양(0~1)을 `--edge-top` / `--edge-bottom` 에 적어둔다. CSS 가 그걸 읽는다. */
export function useScrollEdges(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // 50px 쯤 가려지면 페이드가 가장 진하다. 그 아래로는 비례해서 옅어진다.
    const FADE_RANGE = 50;
    const update = () => {
      const hidden = el.scrollHeight - el.clientHeight;
      const below = hidden - el.scrollTop;
      el.style.setProperty("--edge-top", String(Math.min(el.scrollTop / FADE_RANGE, 1)));
      el.style.setProperty("--edge-bottom", String(hidden <= 0 ? 0 : Math.min(below / FADE_RANGE, 1)));
    };

    update();
    el.addEventListener("scroll", update, { passive: true });
    // 목록이 늘거나 줄면 가려진 양도 달라진다.
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);

    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  });
}

/**
 * 화면에 들어온 자식에게 `data-in` 을 붙인다. 나가면 뗀다 — 다시 스크롤해 올라오면
 * 또 올라온다(원본의 `once: false` 와 같다).
 */
export function useRevealChildren(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          (entry.target as HTMLElement).toggleAttribute("data-in", entry.isIntersecting);
        }
      },
      { root: el, threshold: 0.5 }
    );

    // 자식이 늘고 줄 때마다 다시 건다. 대화를 새로 만들면 바로 그 줄이 올라와야 한다.
    const attach = () => {
      observer.disconnect();
      for (const child of el.children) observer.observe(child);
    };
    attach();
    const mutations = new MutationObserver(attach);
    mutations.observe(el, { childList: true });

    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [ref]);
}

import { invoke } from "@tauri-apps/api/core";
import { DOCK_H, useNekoStore } from "../neko/nekoStore";

/**
 * 맥 메인 창의 최소 높이(사용자: 창 높이를 줄이면 위쪽이 다 잘렸다). 위쪽 줄(제목 막대와 거실 사이)의 칸마다 잘리지 않을
 * 높이를 재서, 제목 막대 + 그중 가장 큰 것 + 거실(사용자가 정한 높이)을 Rust 에 건다(main_min_height). Rust 는 그 화면의
 * 작업 영역 높이까지만 걸고, 창이 작으면 키운다.
 *
 * 칸마다 잘리지 않을 높이:
 * - 사이드바: 대화 목록 몇 줄(.sidebar__list 의 min-height) + 그림판 제목 줄 + 나머지(새 대화·방·상태 띠) 그대로
 * - 채팅: 입력창 + 최근 메시지 몇 줄
 * - 오른쪽 패널: 카드 그대로, 포모도로는 접힌 한 줄, 메모는 min-height(자리가 모자랄 때 RightPanel 이 하는 모양)
 *
 * 화면이 작아 다 못 담으면 거실이 먼저 줄어든다(--dock-max, 저장한 높이는 그대로). 그래도 모자라면 칸 안에서 스크롤한다(CSS).
 */

/** .sidebar__list 의 min-height(App.css)와 같다 */
const LIST_MIN = 72;
/** 입력창 위로 보이는 최근 메시지 몇 줄 */
const CHAT_LINES = 120;
/** .panel-card--memo 의 min-height(RightPanel.css)와 같다 */
const MEMO_MIN = 100;
/** 접힌 포모도로 본문 한 줄(.right-panel--tight .pomo-body: 버튼 28 + 위아래 6) */
const POMO_TIGHT = 40;

const shown = (e: Element | null): e is HTMLElement => e instanceof HTMLElement && e.offsetWidth > 40 && e.offsetHeight > 0;

/**
 * 세로로 쌓인 칸의 높이 합(위치를 띄운 손잡이·숨긴 칸은 뺀다 — 눌려 0 이 된 칸은 사이 틈이 남으니 센다). size 로 칸 하나의
 * 높이를 바꿔 셀 수 있다
 */
function columnNeed(el: HTMLElement, size: (c: HTMLElement) => number = (c) => c.offsetHeight): number {
  const cs = getComputedStyle(el);
  const kids = [...el.children].filter((c): c is HTMLElement => {
    if (!(c instanceof HTMLElement)) return false;
    const s = getComputedStyle(c);
    return s.display !== "none" && s.position !== "absolute" && s.position !== "fixed";
  });
  const gap = parseFloat(cs.rowGap) || 0;
  return (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + kids.reduce((a, c) => a + size(c), 0) + gap * Math.max(0, kids.length - 1);
}

/**
 * 위쪽 줄이 잘리지 않을 높이와 지금 위쪽 줄 높이(px). row: 칸이 grid 줄보다 크거나 작은 만큼(바깥 여백)을 맞추려고 쓴다
 */
export function topNeed(doc: Document = document): { need: number; row: number; title: number; dock: number } | null {
  const app = doc.querySelector<HTMLElement>(".app");
  const title = doc.querySelector<HTMLElement>(".titlebar");
  if (!app || !title) return null;
  const dockEl = doc.querySelector<HTMLElement>(".app > .neko-slot--dock");
  const dock = dockEl?.offsetHeight ?? 0;
  const row = app.clientHeight - title.offsetHeight - dock;
  const needs: number[] = [];
  const fit = (el: HTMLElement, need: number) => needs.push(need + (row - el.offsetHeight));

  const sidebar = doc.querySelector(".sidebar");
  if (shown(sidebar)) {
    fit(sidebar, columnNeed(sidebar, (c) => {
      const list = c.querySelector<HTMLElement>(".sidebar__list");
      if (list) return c.offsetHeight - list.offsetHeight + LIST_MIN;
      // 그림판은 본문이 0 까지 줄게 만들어져 있다 — 제목 줄만 보이면 된다
      if (c.classList.contains("panel-card--draw")) return c.querySelector<HTMLElement>(".panel-card__header")?.offsetHeight ?? 0;
      return c.offsetHeight;
    }));
  }
  const main = doc.querySelector(".main");
  if (shown(main)) fit(main, (doc.querySelector<HTMLElement>(".chat-dock")?.offsetHeight ?? 0) + CHAT_LINES);
  const right = doc.querySelector(".right-panel");
  if (shown(right)) {
    const tight = right.classList.contains("right-panel--tight");
    fit(right, columnNeed(right, (c) => {
      if (c.classList.contains("panel-card--memo")) return MEMO_MIN;
      // 포모도로 본문은 카드가 펼쳐져 있을 때만 카드 높이에 든다(접혀 있으면 제목 줄뿐)
      const pomo = c.querySelector<HTMLElement>(".pomo-body");
      return pomo && !tight && c.offsetHeight > pomo.offsetHeight ? c.offsetHeight - pomo.offsetHeight + POMO_TIGHT : c.offsetHeight;
    }));
  }
  return needs.length ? { need: Math.ceil(Math.max(...needs)), row, title: title.offsetHeight, dock } : null;
}

/** 메인 창(맥)에서 한 번. 칸 크기·거실 높이·자리가 바뀔 때마다 다시 재서 바뀌었을 때만 Rust 에 건다 */
export function watchWindowMin(): () => void {
  let sent = 0, frame = 0;
  const root = document.documentElement;
  const measure = () => {
    frame = 0;
    const t = topNeed();
    if (!t) return;
    const st = useNekoStore.getState().stage;
    const hasDock = !!document.querySelector(".app > .neko-slot--dock");
    // 거실은 사용자가 정한 높이로 센다(지금 줄어 보이는 높이가 아니라)
    const dockH = hasDock ? st.dockH : 0;
    const want = t.title + t.need + dockH;
    // 화면이 작아 다 못 담으면 거실을 먼저 줄인다(저장값은 그대로). 거실 최소보다는 안 줄인다 — 그 아래는 칸 안 스크롤
    const room = window.innerHeight - t.title - t.need;
    if (hasDock && room < dockH) root.style.setProperty("--dock-max", `${Math.max(DOCK_H.min, Math.floor(room))}px`);
    else root.style.removeProperty("--dock-max");
    if (Math.abs(want - sent) >= 1) {
      sent = want;
      void invoke("main_min_height", { h: want }).catch(() => {});
    }
  };
  const later = () => { if (!frame) frame = requestAnimationFrame(measure); };
  const ro = new ResizeObserver(later);
  const watch = () => {
    ro.disconnect();
    for (const s of [".app", ".titlebar", ".sidebar", ".main", ".chat-dock", ".right-panel", ".app > .neko-slot--dock"]) {
      const el = document.querySelector(s);
      if (el) ro.observe(el);
    }
    for (const s of [".sidebar", ".right-panel"]) document.querySelectorAll(`${s} > *`).forEach((c) => ro.observe(c));
    later();
  };
  // 칸이 생기고 없어진다(거실 자리·그림판·사이드바 열고 닫기)
  const mo = new MutationObserver(watch);
  const app = document.querySelector(".app");
  if (app) mo.observe(app, { childList: true, subtree: false });
  for (const s of [".sidebar", ".right-panel"]) { const el = document.querySelector(s); if (el) mo.observe(el, { childList: true }); }
  const off = useNekoStore.subscribe((s, p) => { if (s.stage !== p.stage) later(); });
  window.addEventListener("resize", later);
  watch();
  return () => {
    ro.disconnect();
    mo.disconnect();
    off();
    window.removeEventListener("resize", later);
    cancelAnimationFrame(frame);
    root.style.removeProperty("--dock-max");
  };
}

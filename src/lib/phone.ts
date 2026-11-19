/**
 * 폰(iOS) 화면 준비: 배치·키보드·터치. main.tsx 가 폰 빌드에서만 부른다(맥 화면은 이 파일을 안 탄다).
 * 배치 규칙은 App.css 의 `html.phone`.
 */

import { useNekoStore, type NekoPlacement } from "../neko/nekoStore";

const KBD_KEY = "nekodesk_phone_kbd_h";

/** 키보드: 보이는 높이(--vvh)만큼만 쓴다. 올라오는 걸 기다리지 않고 지난번 키보드 높이로 먼저 줄여 입력 칸이 키보드와 같이 올라온다. */
function fitKeyboard(root: HTMLElement): void {
  const vv = window.visualViewport;
  if (!vv) return;
  // 지금까지 본 가장 큰 높이 = 키보드가 없을 때. innerHeight 는 iOS 버전에 따라 같이 줄어 못 믿는다
  let tallest = 0;
  const apply = (h: number) => {
    root.style.setProperty("--vvh", `${h}px`);
    root.classList.toggle("kbd", tallest - h > 120);
  };
  const isField = (t: EventTarget | null) => t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !/^(checkbox|radio|range|button|color|file)$/.test(t.type));
  // 치는 칸이 키보드에 가리지 않게: 화면이 줄어든 뒤, 그 칸을 감싼 스크롤 칸(설정 등) 안에서 보이는 자리로 올린다
  let reveal = 0;
  const showField = () => {
    clearTimeout(reveal);
    reveal = window.setTimeout(() => {
      const el = document.activeElement;
      if (isField(el)) (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
    }, 280);
  };
  const fit = () => {
    tallest = Math.max(tallest, vv.height);
    apply(vv.height);
    if (tallest - vv.height > 120) { localStorage.setItem(KBD_KEY, String(Math.round(tallest - vv.height))); showField(); }
  };
  let settle = 0;
  const guess = (open: boolean) => {
    const h = Number(localStorage.getItem(KBD_KEY));
    if (open && h > 120) apply(tallest - h);
    else if (!open) apply(tallest);
    // 짐작이 틀렸으면(외장 키보드 등) 실제 높이로 되돌린다
    clearTimeout(settle);
    settle = window.setTimeout(fit, 700);
  };
  document.addEventListener("focusin", (e) => { if (isField(e.target)) { guess(true); showField(); } });
  document.addEventListener("focusout", (e) => { if (isField(e.target) && !isField((e as FocusEvent).relatedTarget)) guess(false); });
  window.addEventListener("orientationchange", () => { tallest = 0; });
  vv.addEventListener("resize", fit);
  fit();
}

/**
 * 손가락엔 '올려 둠'이 없다. iOS 는 누른 자리에 :hover 를 남겨, 손을 뗀 뒤에도 버튼이 눌린 듯 떠 있었다.
 * ponytail: 스타일시트를 돌며 :hover 규칙을 죽인다. 규칙이 늦게 붙는 시트(코드 분할)가 생기면 그때 한 번 더 돈다.
 */
function dropHover(): void {
  const walk = (rules: CSSRuleList) => {
    for (const r of Array.from(rules)) {
      if (r instanceof CSSStyleRule && r.selectorText.includes(":hover")) r.selectorText = r.selectorText.replace(/:hover/g, ":not(*)");
      if ("cssRules" in r) walk((r as CSSGroupingRule).cssRules);
    }
  };
  const run = () => {
    for (const sheet of Array.from(document.styleSheets)) {
      try { walk(sheet.cssRules); } catch { /* 다른 출처 시트는 못 읽는다 */ }
    }
  };
  run();
  window.addEventListener("load", run);
  new MutationObserver(run).observe(document.head, { childList: true });
}

/**
 * 대화 목록(폰의 왼쪽 장)이 열려 있나. React 상태가 아니라 html 의 `data-drawer` 하나다 — App 상태로 두면 여닫을 때마다
 * App 전체가 다시 그려져(대화가 길면 수십 ms) 미는 움직임이 버벅였고, 끌다 놓으면 다시 그리는 동안 장이 잠깐 거꾸로 갔다.
 */
export const drawer = {
  isOpen: () => document.documentElement.hasAttribute("data-drawer"),
  set: (open: boolean) => { document.documentElement.toggleAttribute("data-drawer", open); },
  toggle: () => { document.documentElement.toggleAttribute("data-drawer"); },
};

/** 손짓으로 여닫는 두 장: 대화 목록(왼쪽에서, 위의 `drawer`)과 설정(오른쪽에서, 열림 상태는 App 이 갖는다). */
export interface Panels {
  sheetOpen: boolean;
  setSheet(open: boolean): void;
}
let panels: (() => Panels) | null = null;
export function bindPanels(get: () => Panels): () => void {
  panels = get;
  return () => { if (panels === get) panels = null; };
}

/**
 * 끝에서 미는 손짓: 장이 손가락을 따라 움직이고, 손을 뗄 때 정해진다(절반 못 미쳐도 빠르게 밀면 넘어간다).
 *   왼쪽 끝 → 오른쪽: 설정이 열려 있으면 설정을 닫고, 아니면 대화 목록을 연다.
 *   오른쪽 끝(또는 대화 목록 옆 가림막) → 왼쪽: 대화 목록이 열려 있으면 닫고, 아니면 설정을 연다.
 * 그리는 건 CSS 변수로 한다(App.css): --drawer-x·--scrim(대화 목록), --sheet-x·--sheet-p(설정). 뒤 화면은 열린 만큼 흐려진다. 끄는 동안은 html 에
 * drag-drawer / drag-sheet 를 붙여 전환을 끄고, 놓으면 떼어 남은 거리를 전환이 마저 간다.
 */
function watchEdgeDrags(root: HTMLElement): void {
  const EDGE = 28, LOCK = 10, FLICK = 0.4; // px, px, px/ms
  type Drag = { kind: "drawer" | "sheet"; opening: boolean; dir: 1 | -1; w: number; x0: number; y0: number; locked: boolean; open: number; lastX: number; lastT: number; v: number };
  let drag: Drag | null = null;
  // 놓은 뒤 치울 것(끄는 동안 붙인 클래스·변수). 다음 손짓이 먼저 시작되면 그때 바로 치운다 — 타이머만 지우면
  // 설정을 끌다 놓고 곧바로 대화 목록을 끌 때 설정의 자리 값이 남아, 다음에 설정을 누르면 반쯤 나온 채 멈췄다
  let cleanup = 0;
  let pending: (() => void) | null = null;
  const later = (ms: number, fn: () => void) => {
    pending = fn;
    cleanup = window.setTimeout(() => { pending?.(); pending = null; }, ms);
  };
  const flush = () => { clearTimeout(cleanup); pending?.(); pending = null; };
  // 대화 목록의 보이는 폭(App.css 의 --panel-w 와 같은 식). 설정은 화면 폭 전체다
  const drawerWidth = () => Math.min(window.innerWidth * 0.86, 340);

  const paint = (d: Drag) => {
    if (d.kind === "drawer") {
      root.style.setProperty("--drawer-x", `${d.open - d.w}px`);
      root.style.setProperty("--scrim", String(d.open / d.w));
    } else {
      root.style.setProperty("--sheet-x", `${d.w - d.open}px`);
      root.style.setProperty("--sheet-p", String(d.open / d.w));
    }
  };

  document.addEventListener("touchstart", (e) => {
    drag = null;
    const p = panels?.();
    // 네코 꾸미기·선물함이 떠 있으면 그 밑의 장을 끌지 않는다
    if (!p || e.touches.length !== 1 || document.querySelector(".phone-panel") || root.classList.contains("standby")) return;
    const t = e.touches[0];
    const target = e.target as Element | null;
    const onScrim = target?.classList?.contains("drawer-scrim");
    // 버튼·입력 칸에서 시작한 건 누르기다. 설정 버튼이 오른쪽 끝에 있어, 누르다 손가락이 조금 밀리면 끌기로 잡혔다
    if (!onScrim && target?.closest?.("button, a, input, textarea, select, [role='tab']")) return;
    const side = t.clientX <= EDGE ? "left" : t.clientX >= window.innerWidth - EDGE || onScrim ? "right" : null;
    if (!side) return;
    const pick = side === "left"
      ? (p.sheetOpen ? { kind: "sheet" as const, opening: false } : !drawer.isOpen() ? { kind: "drawer" as const, opening: true } : null)
      : (drawer.isOpen() ? { kind: "drawer" as const, opening: false } : !p.sheetOpen ? { kind: "sheet" as const, opening: true } : null);
    if (!pick) return;
    const w = pick.kind === "drawer" ? drawerWidth() : window.innerWidth;
    drag = { ...pick, dir: side === "left" ? 1 : -1, w, x0: t.clientX, y0: t.clientY, locked: false, open: pick.opening ? 0 : w, lastX: t.clientX, lastT: e.timeStamp, v: 0 };
  }, { passive: true, capture: true });

  document.addEventListener("touchmove", (e) => {
    const d = drag;
    if (!d) return;
    const t = e.touches[0], dx = (t.clientX - d.x0) * d.dir, dy = t.clientY - d.y0;
    if (!d.locked) {
      if (Math.abs(dy) > LOCK && Math.abs(dy) > Math.abs(dx)) { drag = null; return; } // 세로로 민다 = 스크롤
      if (dx < LOCK) return;
      d.locked = true;
      flush();
      root.classList.add(`drag-${d.kind}`);
      // 설정은 열려야 화면에 있다. 손가락 자리에서 시작하게 먼저 그리고 연다
      if (d.kind === "sheet" && d.opening) { paint(d); panels?.().setSheet(true); }
    }
    if (e.cancelable) e.preventDefault();
    // 여는 손짓은 민 만큼 열리고, 닫는 손짓은 민 만큼 닫힌다. 손가락이 가는 쪽: 대화 목록·설정 닫기 = dir, 설정 열기·대화 목록 닫기도 dir
    d.open = Math.max(0, Math.min(d.w, d.opening ? dx : d.w - dx));
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) d.v = ((t.clientX - d.lastX) * d.dir) / dt;
    d.lastX = t.clientX; d.lastT = e.timeStamp;
    paint(d);
  }, { passive: false, capture: true });

  const end = () => {
    const d = drag;
    drag = null;
    if (!d?.locked) return;
    const p = panels?.();
    // 놓는 순간: 빠르게 밀었으면 그쪽으로, 아니면 더 가까운 쪽으로
    const forward = d.v > FLICK || (d.v > -FLICK && (d.opening ? d.open > d.w * 0.4 : d.open < d.w * 0.6));
    const open = d.opening ? forward : !forward;
    if (d.kind === "drawer") {
      root.classList.remove("drag-drawer");
      root.style.removeProperty("--drawer-x");
      root.style.removeProperty("--scrim");
      drawer.set(open);
      return;
    }
    if (open) { // 남은 거리를 전환이 간다
      root.classList.remove("drag-sheet");
      root.style.setProperty("--sheet-x", "0px");
      root.style.setProperty("--sheet-p", "1");
      p?.setSheet(true);
      later(520, () => { root.style.removeProperty("--sheet-x"); root.style.removeProperty("--sheet-p"); });
    } else { // 닫힘: 지금 자리에서 나가는 애니메이션(MenuModal.css menu-slide-out 의 --menu-from). 다 나갈 때까지 자리를 붙들어 둔다
      root.style.setProperty("--menu-from", `${d.w - d.open}px`);
      p?.setSheet(false);
      later(400, () => {
        root.classList.remove("drag-sheet");
        root.style.removeProperty("--sheet-x");
        root.style.removeProperty("--sheet-p");
        root.style.removeProperty("--menu-from");
      });
    }
  };
  document.addEventListener("touchend", end, { capture: true });
  document.addEventListener("touchcancel", end, { capture: true });
}

/**
 * 가로로 돌리면 네코만 보는 화면(아이폰의 스탠바이처럼): 제목 줄·대화를 걷고 거실이 화면을 채운다. 네코가 방에 있었으면
 * 그동안만 거실로 나온다(저장하지 않는다 — 세로로 돌리면 있던 자리로 돌아간다). 켜 둔 동안 화면이 꺼지지 않게 해 본다.
 */
function watchStandby(root: HTMLElement): void {
  const landscape = window.matchMedia("(orientation: landscape)");
  let before: NekoPlacement | null = null;
  let awake: { release(): Promise<void> } | null = null;
  const apply = () => {
    const on = landscape.matches;
    root.classList.toggle("standby", on);
    const stage = useNekoStore.getState().stage;
    if (on) {
      before ??= stage.placement;
      if (stage.placement !== "dock") useNekoStore.setState({ stage: { ...stage, placement: "dock" } });
      drawer.set(false);
      // ponytail: 웹뷰가 Wake Lock 을 안 주면 그냥 자동 잠금 시간에 꺼진다
      const lock = (navigator as Navigator & { wakeLock?: { request(kind: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      if (!awake) void lock?.request("screen").then((l) => { if (landscape.matches) awake = l; else void l.release(); }).catch(() => {});
    } else {
      if (before && before !== stage.placement) useNekoStore.setState({ stage: { ...stage, placement: before } });
      before = null;
      void awake?.release().catch(() => {});
      awake = null;
    }
  };
  landscape.addEventListener("change", apply);
  apply();
}

export function startPhone(): void {
  const root = document.documentElement;
  root.classList.add("phone");
  // 입력 칸을 누를 때 iOS 가 화면을 확대하지 않게(글자를 16px 로 키우는 대신)
  document.querySelector('meta[name="viewport"]')?.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover");
  fitKeyboard(root);
  dropHover();
  watchEdgeDrags(root);
  watchStandby(root);
}

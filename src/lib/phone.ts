/**
 * 폰(iOS) 화면 준비: 배치·키보드·터치. main.tsx 가 폰 빌드에서만 부른다(맥 화면은 이 파일을 안 탄다).
 * 배치 규칙은 App.css 의 `html.phone`.
 */

import { invoke } from "@tauri-apps/api/core";
import { useNekoStore, type NekoPlacement } from "../neko/nekoStore";
import { usePhonePanel } from "../neko/panel";

const KBD_KEY = "nekodesk_phone_kbd_h";

/** 키보드가 올라와 있나(120px 넘게 가렸나) — 이때는 끝에서 미는 손짓을 받지 않는다 */
let kbdUp = false;
export const keyboardUp = (): boolean => kbdUp;

const isField = (t: EventTarget | null): boolean =>
  t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !/^(checkbox|radio|range|button|color|file)$/.test(t.type));

/** 치고 있던 칸을 놓아 키보드를 내린다(대화 목록·설정·선물함을 열 때) */
export function dismissKeyboard(): void {
  const el = document.activeElement;
  if (isField(el)) (el as HTMLElement).blur();
}

/**
 * 채팅 바가 키보드를 따라 transform 으로 움직이는 동안 그 안의 입력 커서를 숨긴다. iOS 는 커서를 웹 화면이 아니라 앱 쪽에
 * 따로 그려서, transform 전환(합성 층)을 따라오지 않고 움직이기 전 자리에 남았다가 늦게 따라왔다. 다 움직이면 선택 범위를 한 번
 * 다시 적어 커서가 지금 자리로 오게 하고(웹킷이 커서 자리를 다시 보낸다) 보이게 한다. 움직임은 그대로 transform 이라 버벅이지 않는다.
 */
let caretTimer = 0;
function hideCaretWhileLifting(): void {
  const dock = document.querySelector<HTMLElement>(".chat-dock");
  const field = document.activeElement;
  if (!dock || !(field instanceof HTMLTextAreaElement) || !dock.contains(field)) return;
  field.style.caretColor = "transparent";
  clearTimeout(caretTimer);
  let done = false;
  const show = () => {
    if (done) return;
    done = true;
    dock.removeEventListener("transitionend", onEnd);
    clearTimeout(caretTimer);
    // 한 프레임 뒤(움직인 층이 화면에 올라간 뒤) 커서 자리를 다시 맞춘다
    requestAnimationFrame(() => {
      if (document.activeElement === field) {
        const { selectionStart: a, selectionEnd: b, selectionDirection: d } = field;
        field.setSelectionRange(a, b, d ?? undefined);
      }
      field.style.removeProperty("caret-color");
    });
  };
  const onEnd = (e: TransitionEvent) => { if (e.target === dock && e.propertyName === "transform") show(); };
  dock.addEventListener("transitionend", onEnd);
  // 전환이 안 일어나거나(같은 자리) 끝 알림을 놓쳐도 커서가 숨은 채 남지 않게
  caretTimer = window.setTimeout(show, 400);
}

/**
 * 키보드: 높이 하나(--kbd, 대화 칸 .main 에)로만 반영한다. 채팅 바는 그만큼 transform 으로 올라가고(합성 층에서만, 전환이
 * 키보드와 같이 간다) 대화 목록은 아래 여백이 한 번 바뀐다 — 화면 높이를 줄이며 매 프레임 다시 배치하던 때는 올라오며 버벅였다.
 * 맨 아래를 보고 있었으면 맨 아래에 다시 맞춘다(안 그러면 최근 답이 키보드 뒤에 가렸다).
 * 위에 뜬 장(설정·선물함)은 보이는 높이(--vvh)까지만 쓴다 — 그 안의 입력 칸이 키보드에 깔리지 않게.
 * 키보드가 올라오는 걸 기다리지 않고 지난번 높이로 먼저 올려 채팅 바가 키보드와 같이 올라간다.
 */
function fitKeyboard(root: HTMLElement): void {
  const vv = window.visualViewport;
  if (!vv) return;
  // 지금까지 본 가장 큰 높이 = 키보드가 없을 때. innerHeight 는 iOS 버전에 따라 같이 줄어 못 믿는다
  let tallest = 0, last = -1;
  const apply = (k: number) => {
    k = Math.max(0, Math.round(k));
    if (k === last) return;
    last = k;
    kbdUp = k > 120;
    const sc = document.querySelector<HTMLElement>(".chat-messages");
    const atBottom = !!sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 80;
    hideCaretWhileLifting();
    document.querySelector<HTMLElement>(".main")?.style.setProperty("--kbd", `${k}px`);
    if (sc && atBottom) sc.scrollTop = sc.scrollHeight;
    // 문서 맨 위에 변수를 바꾸면 화면 전체가 다시 계산된다 — 위에 뜬 장이 있을 때만
    if (k && document.querySelector(".menu-backdrop, .phone-panel")) root.style.setProperty("--vvh", `${tallest - k}px`);
    else root.style.removeProperty("--vvh");
  };
  // 위에 뜬 장 안의 칸이면, 장이 줄어든 뒤 그 칸이 보이는 자리로 올린다
  let reveal = 0;
  const showField = () => {
    clearTimeout(reveal);
    reveal = window.setTimeout(() => {
      const el = document.activeElement;
      if (isField(el) && (el as HTMLElement).closest(".menu-backdrop, .phone-panel")) (el as HTMLElement).scrollIntoView({ block: "center", behavior: "smooth" });
    }, 280);
  };
  const fit = () => {
    tallest = Math.max(tallest, vv.height);
    const k = tallest - vv.height;
    apply(k);
    if (k > 120) { localStorage.setItem(KBD_KEY, String(Math.round(k))); showField(); }
  };
  let settle = 0;
  const guess = (open: boolean) => {
    const h = Number(localStorage.getItem(KBD_KEY));
    if (open && h > 120) apply(h);
    else if (!open) apply(0);
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
  set: (open: boolean) => {
    if (open) dismissKeyboard();
    document.documentElement.toggleAttribute("data-drawer", open);
  },
  toggle: () => drawer.set(!drawer.isOpen()),
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
 *   왼쪽 끝 → 오른쪽: 맨 위에 뜬 장(선물함·꾸미기, 그다음 설정)을 닫는다. 아무것도 없으면 대화 목록을 연다 — 아이폰의 뒤로 가기 손짓.
 *   오른쪽 끝(또는 대화 목록 옆 가림막) → 왼쪽: 대화 목록이 열려 있으면 닫고, 아무것도 없으면 설정을 연다.
 * 키보드가 올라와 있거나, 무대에서 물건을 잡고 있으면(html[data-holding]) 받지 않는다.
 * 끄는 동안은 움직이는 장 하나에 transform(가림막은 opacity)만 바로 적는다 — 문서 맨 위의 변수로 그리면 프레임마다 화면 전체가
 * 다시 계산돼 버벅였다. html 의 drag-* 는 끄는 동안 전환을 끄고, 놓으면 떼어 남은 거리를 전환이 마저 간다.
 */
function watchEdgeDrags(root: HTMLElement): void {
  const EDGE = 28, LOCK = 10, FLICK = 0.4; // px, px, px/ms
  type Kind = "drawer" | "sheet" | "panel";
  type Drag = { kind: Kind; opening: boolean; dir: 1 | -1; w: number; x0: number; y0: number; locked: boolean; open: number; lastX: number; lastT: number; v: number };
  let drag: Drag | null = null;
  // 놓은 뒤 치울 것. 다음 손짓이 먼저 시작되면 그때 바로 치운다(타이머만 지우면 자리 값이 남아 장이 반쯤 나온 채 멈췄다)
  let cleanup = 0;
  let pending: (() => void) | null = null;
  const later = (ms: number, fn: () => void) => {
    pending = fn;
    cleanup = window.setTimeout(() => { pending?.(); pending = null; }, ms);
  };
  const flush = () => { clearTimeout(cleanup); pending?.(); pending = null; };
  // 대화 목록의 보이는 폭(App.css 의 --panel-w 와 같은 식). 설정·선물함은 화면 폭 전체다
  const drawerWidth = () => Math.min(window.innerWidth * 0.86, 340);
  const el = (sel: string) => document.querySelector<HTMLElement>(sel);
  const SOFT = "transform var(--soft-dur) var(--soft)";

  const paint = (d: Drag) => {
    const p = d.open / d.w;
    if (d.kind === "drawer") {
      const side = el(".sidebar"), scrim = el(".drawer-scrim");
      if (side) side.style.transform = `translateX(${d.open - d.w}px)`;
      if (scrim) scrim.style.opacity = String(p);
    } else if (d.kind === "sheet") {
      const modal = el(".menu-modal");
      if (modal) {
        modal.style.transform = `translateX(${d.w - d.open}px)`;
        el(".menu-backdrop")?.style.setProperty("--sheet-p", String(p));
      } else {
        // 막 여는 중이라 아직 안 그려졌다: 그려질 때 이 자리에서 나오게 한 번만 맨 위에 적는다
        root.style.setProperty("--sheet-x", `${d.w - d.open}px`);
        root.style.setProperty("--sheet-p", String(p));
      }
    } else {
      const panel = el(".phone-panel");
      if (panel) panel.style.transform = `translateX(${d.w - d.open}px)`;
    }
  };
  const unpaint = (kind: Kind) => {
    if (kind === "drawer") {
      el(".sidebar")?.style.removeProperty("transform");
      el(".drawer-scrim")?.style.removeProperty("opacity");
    } else if (kind === "sheet") {
      el(".menu-modal")?.style.removeProperty("transform");
      el(".menu-backdrop")?.style.removeProperty("--sheet-p");
      root.style.removeProperty("--sheet-x");
      root.style.removeProperty("--sheet-p");
    }
  };

  document.addEventListener("touchstart", (e) => {
    drag = null;
    const p = panels?.();
    if (!p || e.touches.length !== 1 || kbdUp || root.classList.contains("standby") || root.hasAttribute("data-holding")) return;
    const t = e.touches[0];
    const target = e.target as Element | null;
    const onScrim = target?.classList?.contains("drawer-scrim");
    // 버튼·입력 칸에서 시작한 건 누르기다. 설정 버튼이 오른쪽 끝에 있어, 누르다 손가락이 조금 밀리면 끌기로 잡혔다
    if (!onScrim && target?.closest?.("button, a, input, textarea, select, [role='tab']")) return;
    const side = t.clientX <= EDGE ? "left" : t.clientX >= window.innerWidth - EDGE || onScrim ? "right" : null;
    if (!side) return;
    const pick: { kind: Kind; opening: boolean } | null = el(".phone-panel")
      ? (side === "left" ? { kind: "panel", opening: false } : null)
      : side === "left"
        ? (p.sheetOpen ? { kind: "sheet", opening: false } : !drawer.isOpen() ? { kind: "drawer", opening: true } : null)
        : (drawer.isOpen() ? { kind: "drawer", opening: false } : !p.sheetOpen ? { kind: "sheet", opening: true } : null);
    if (!pick) return;
    const w = pick.kind === "drawer" ? drawerWidth() : window.innerWidth;
    drag = { ...pick, dir: side === "left" ? 1 : -1, w, x0: t.clientX, y0: t.clientY, locked: false, open: pick.opening ? 0 : w, lastX: t.clientX, lastT: e.timeStamp, v: 0 };
  }, { passive: true, capture: true });

  document.addEventListener("touchmove", (e) => {
    const d = drag;
    if (!d || root.dataset.holding) { drag = null; return; } // 네코 무대에서 고양이·선물을 잡은 동안(neko/holding)은 손짓이 아니다
    const t = e.touches[0], dx = (t.clientX - d.x0) * d.dir, dy = t.clientY - d.y0;
    if (!d.locked) {
      if (Math.abs(dy) > LOCK && Math.abs(dy) > Math.abs(dx)) { drag = null; return; } // 세로로 민다 = 스크롤
      if (dx < LOCK) return;
      d.locked = true;
      flush();
      if (d.kind !== "panel") root.classList.add(`drag-${d.kind}`);
      else el(".phone-panel")?.style.removeProperty("transition");
      if (d.kind === "drawer" && d.opening) dismissKeyboard();
      // 설정은 열려야 화면에 있다. 손가락 자리에서 시작하게 먼저 그리고 연다
      if (d.kind === "sheet" && d.opening) { paint(d); panels?.().setSheet(true); }
    }
    if (e.cancelable) e.preventDefault();
    // 여는 손짓은 민 만큼 열리고, 닫는 손짓은 민 만큼 닫힌다
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
      // 적어 둔 자리를 지우고 클래스를 떼면, 전환이 지금 자리에서 열림·닫힘 자리까지 간다
      unpaint("drawer");
      root.classList.remove("drag-drawer");
      drawer.set(open);
      return;
    }
    if (d.kind === "panel") {
      const panel = el(".phone-panel");
      if (!panel) return;
      panel.style.transition = SOFT;
      panel.style.transform = open ? "" : "translateX(100%)";
      later(460, () => {
        if (open) panel.style.removeProperty("transition");
        else usePhonePanel.getState().close();
      });
      return;
    }
    if (open) { // 남은 거리를 전환이 간다
      unpaint("sheet");
      root.classList.remove("drag-sheet");
      p?.setSheet(true);
    } else { // 닫힘: 지금 자리에서 나가는 애니메이션(MenuModal.css menu-slide-out 의 --menu-from). 다 나갈 때까지 자리를 붙들어 둔다
      el(".menu-modal")?.style.setProperty("--menu-from", `${d.w - d.open}px`);
      p?.setSheet(false);
      later(400, () => {
        root.classList.remove("drag-sheet");
        unpaint("sheet");
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
    // 홈 막대를 숨긴다(손을 대지 않는 동안)
    void invoke("phone_standby", { on }).catch(() => {});
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

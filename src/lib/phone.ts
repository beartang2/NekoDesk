/**
 * 폰(iOS) 화면 준비: 배치·키보드·터치. main.tsx 가 폰 빌드에서만 부른다(맥 화면은 이 파일을 안 탄다).
 * 배치 규칙은 App.css 의 `html.phone`.
 */

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
  const fit = () => {
    tallest = Math.max(tallest, vv.height);
    apply(vv.height);
    if (tallest - vv.height > 120) localStorage.setItem(KBD_KEY, String(Math.round(tallest - vv.height)));
  };
  const isField = (t: EventTarget | null) => t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && !/^(checkbox|radio|range|button|color|file)$/.test(t.type));
  let settle = 0;
  const guess = (open: boolean) => {
    const h = Number(localStorage.getItem(KBD_KEY));
    if (open && h > 120) apply(tallest - h);
    else if (!open) apply(tallest);
    // 짐작이 틀렸으면(외장 키보드 등) 실제 높이로 되돌린다
    clearTimeout(settle);
    settle = window.setTimeout(fit, 700);
  };
  document.addEventListener("focusin", (e) => { if (isField(e.target)) guess(true); });
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

export type EdgeSwipe = "from-left" | "from-right";
const swipeSubs = new Set<(s: EdgeSwipe) => void>();
/** 화면 왼쪽 끝에서 오른쪽으로, 오른쪽 끝에서 왼쪽으로 민 손짓(App 이 대화 목록·설정을 여닫는다). */
export function onEdgeSwipe(fn: (s: EdgeSwipe) => void): () => void {
  swipeSubs.add(fn);
  return () => { swipeSubs.delete(fn); };
}

/** 끝에서 시작해(EDGE) 가로로 충분히(MIN) 밀면 한 번 알린다. 세로로 더 많이 움직이면 스크롤이라 버린다. */
function watchEdgeSwipes(): void {
  const EDGE = 28, MIN = 48;
  let from: EdgeSwipe | null = null, x0 = 0, y0 = 0;
  document.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    from = e.touches.length !== 1 ? null : t.clientX <= EDGE ? "from-left" : t.clientX >= window.innerWidth - EDGE ? "from-right" : null;
    x0 = t.clientX; y0 = t.clientY;
  }, { passive: true, capture: true });
  document.addEventListener("touchmove", (e) => {
    if (!from) return;
    const t = e.touches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 12) { from = null; return; }
    if ((from === "from-left" ? dx : -dx) < MIN) return;
    const s = from;
    from = null;
    swipeSubs.forEach((fn) => fn(s));
  }, { passive: true, capture: true });
}

export function startPhone(): void {
  const root = document.documentElement;
  root.classList.add("phone");
  // 입력 칸을 누를 때 iOS 가 화면을 확대하지 않게(글자를 16px 로 키우는 대신)
  document.querySelector('meta[name="viewport"]')?.setAttribute("content", "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover");
  fitKeyboard(root);
  dropHover();
  watchEdgeSwipes();
}

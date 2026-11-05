import { getCurrentWindow } from "@tauri-apps/api/window";
import { applyThemeColors } from "../theme-colors";
import { loadThemePref, resolveDark, windowTheme } from "./theme";

/**
 * 따로 뜬 창(빠른 질문·캡처 막·뷰어)을 메인 창과 같은 테마로. 같은 origin 이라 localStorage 를
 * 같이 쓰지만, 각 창은 메인 창이 테마를 바꿀 때 알 길이 없어 열릴 때마다 다시 읽는다.
 * `nativeTitle` 은 macOS 창 틀(제목 표시줄)까지 맞출 때 — 투명한 캡처 막엔 틀이 없다.
 */
export function syncWindowTheme(nativeTitle = true) {
  const pref = loadThemePref();
  const apply = (isDark: boolean) => {
    document.documentElement.classList.toggle("light", !isDark);
    applyThemeColors(isDark);
  };
  apply(resolveDark(pref));
  if (!nativeTitle) return;
  // 시스템이면 창 테마를 풀고 나서 창에 다시 묻는다 — 웹뷰의 matchMedia 는 늦거나 틀린다(App 의 useTheme).
  const w = getCurrentWindow();
  w.setTheme(windowTheme(pref))
    .then(() => (pref === "system" ? w.theme() : null))
    .then((t) => { if (t) apply(t === "dark"); })
    .catch(() => {});
}

import { create } from "zustand";

/** 라이트·다크를 고르거나 macOS 설정을 따른다. */
export type ThemePref = "light" | "dark" | "system";

const THEME_KEY = "nekodesk_theme";

export function loadThemePref(): ThemePref {
  const v = localStorage.getItem(THEME_KEY);
  return v === "dark" || v === "system" ? v : "light";
}

/**
 * 웹뷰의 prefers-color-scheme 은 창 모양(appearance)을 따른다. 창 테마를 null 로 두면
 * 그게 macOS 설정이고, 라이트·다크로 박아 두면 그 값이다.
 */
export const systemDarkQuery = () => window.matchMedia("(prefers-color-scheme: dark)");

export function resolveDark(pref: ThemePref): boolean {
  return pref === "system" ? systemDarkQuery().matches : pref === "dark";
}

/** 창 틀에 넘길 값. 시스템이면 null — 틀이 macOS 를 따라가야 웹뷰도 따라간다. */
export const windowTheme = (pref: ThemePref) => (pref === "system" ? null : pref);

export const useThemePref = create<{ pref: ThemePref; setPref: (pref: ThemePref) => void }>((set) => ({
  pref: loadThemePref(),
  setPref: (pref) => {
    localStorage.setItem(THEME_KEY, pref);
    set({ pref });
  },
}));

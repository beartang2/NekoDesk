// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { loadThemePref, resolveDark, windowTheme } from "./theme";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
  });
});

it("저장값이 없거나 이상하면 라이트, 시스템이면 macOS 값을 따른다", () => {
  expect(loadThemePref()).toBe("light");
  localStorage.setItem("nekodesk_theme", "weird");
  expect(loadThemePref()).toBe("light");
  localStorage.setItem("nekodesk_theme", "system");
  expect(loadThemePref()).toBe("system");

  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  expect(resolveDark("system")).toBe(true);
  expect(resolveDark("light")).toBe(false);
  expect(windowTheme("system")).toBeNull();
  expect(windowTheme("dark")).toBe("dark");
});
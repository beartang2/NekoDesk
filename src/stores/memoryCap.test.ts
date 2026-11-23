import { describe, expect, it, vi } from "vitest";

/** 기억 상한(기억 잊기, 0.1.29): 기본 300, 사용자가 바꾸되 범위 안으로 */
vi.hoisted(() => {
  const kv = new Map<string, string>();
  globalThis.localStorage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) } as Storage;
});

import { MEMORY_CAP, memoryCapOf, useSettingsStore } from "./settingsStore";

describe("기억 상한", () => {
  it("기본 300, 이상한 값은 기본, 범위 밖은 끝으로", () => {
    expect(memoryCapOf(null)).toBe(300);
    expect(memoryCapOf("abc")).toBe(300);
    expect(memoryCapOf("0")).toBe(300);
    expect(memoryCapOf("10")).toBe(MEMORY_CAP.min);
    expect(memoryCapOf("99999")).toBe(MEMORY_CAP.max);
    expect(memoryCapOf("450")).toBe(450);
  });
  it("바꾸면 이 기기에 남는다", () => {
    useSettingsStore.getState().setMemoryCap(500);
    expect(useSettingsStore.getState().memoryCap).toBe(500);
    expect(localStorage.getItem("nekodesk_memory_cap")).toBe("500");
  });
});

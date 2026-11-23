// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 벽지·기억 상한·기억 정리를 맥·폰 같이(0.1.30, 사용자: 벽지가 맥이랑 다르다): 처음엔 사용자가 고른 값만 올리고(기본값은 안 올려 다른
 * 기기 값을 안 덮는다), 받은 값은 이 앱이 아는 값으로 맞춰 화면에 바로, 바꾸면 DB 에도
 */
const h = vi.hoisted(() => {
  const kv = new Map<string, string>();
  globalThis.localStorage = { getItem: (k: string) => kv.get(k) ?? null, setItem: (k: string, v: string) => void kv.set(k, v), removeItem: (k: string) => void kv.delete(k) } as Storage;
  return { kv, db: new Map<string, string>(), sets: [] as [string, string][] };
});
vi.mock("../api/tauri", () => ({
  settingsApi: {
    get: async (k: string) => h.db.get(k) ?? null,
    set: async (k: string, v: string) => { h.sets.push([k, v]); h.db.set(k, v); },
  },
}));

const fresh = async () => { vi.resetModules(); return import("./settingsStore"); };
beforeEach(() => { h.kv.clear(); h.db.clear(); h.sets = []; });

describe("같이 쓰는 벽지·기억 설정", () => {
  it("DB 에 아직 없으면 이 기기에서 고른 값만 올리고, 기본값(고른 적 없음)은 안 올린다", async () => {
    h.kv.set("nekodesk_neko_wallpaper", "panel");
    h.kv.set("nekodesk_memory_tidy", "off");
    const { hydrateSyncedSettings } = await fresh();
    await hydrateSyncedSettings();
    await new Promise((ok) => setTimeout(ok, 0));
    expect(h.sets).toEqual(expect.arrayContaining([["neko_wallpaper", "panel"], ["memory_tidy", "off"]]));
    expect(h.sets.some(([k]) => k === "memory_cap")).toBe(false);
  });

  it("다른 기기에서 온 값으로 화면을 바로 바꾸고, 모르는 값은 이 앱이 아는 값으로(DB 엔 다시 안 적는다)", async () => {
    h.kv.set("nekodesk_neko_wallpaper", "plain");
    h.db.set("neko_wallpaper", "twotone");
    h.db.set("memory_cap", "99999");
    h.db.set("memory_tidy", "off");
    const { hydrateSyncedSettings, useSettingsStore, MEMORY_CAP } = await fresh();
    await hydrateSyncedSettings();
    const s = useSettingsStore.getState();
    expect([s.nekoWallpaper, s.memoryCap, s.memoryTidy]).toEqual(["twotone", MEMORY_CAP.max, false]);
    expect(h.kv.get("nekodesk_neko_wallpaper")).toBe("twotone");
    expect(h.sets).toEqual([]);
    h.db.set("neko_wallpaper", "새 벽지(다음 버전)");
    await hydrateSyncedSettings();
    expect(useSettingsStore.getState().nekoWallpaper).toBe("plain");
  });

  it("바꾸면 이 기기와 DB(동기화) 둘 다에", async () => {
    const { useSettingsStore } = await fresh();
    const s = useSettingsStore.getState();
    s.setNekoWallpaper("wainscot");
    s.setMemoryCap(450);
    s.setMemoryTidy(false);
    await new Promise((ok) => setTimeout(ok, 0));
    expect(h.sets).toEqual([["neko_wallpaper", "wainscot"], ["memory_cap", "450"], ["memory_tidy", "off"]]);
    expect(h.kv.get("nekodesk_memory_cap")).toBe("450");
  });

  it("다른 창은 localStorage 알림(storage)으로 다시 읽는다", async () => {
    const { useSettingsStore } = await fresh();
    window.dispatchEvent(Object.assign(new Event("storage"), { key: "nekodesk_neko_wallpaper", newValue: "panel" }));
    expect(useSettingsStore.getState().nekoWallpaper).toBe("panel");
  });
});

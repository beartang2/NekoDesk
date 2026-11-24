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

describe("같이 쓰는 Claude 컨텍스트 크기(0.1.33, 사용자: 같은 세션인데 폰 64k·맥 128k 라 밥 게이지가 다르다)", () => {
  const SONNET = "claude-sonnet-5-5", K = "nekodesk_claude_context";
  it("DB 에 아직 없으면 이 기기에서 고른 값만 올리고, 고른 적 없으면 안 올린다(기본값이 다른 기기 값을 안 덮는다)", async () => {
    let { hydrateSyncedSettings } = await fresh();
    await hydrateSyncedSettings();
    expect(h.sets.some(([k]) => k === "claude_context")).toBe(false);
    h.kv.set(K, JSON.stringify({ [SONNET]: 64_000 }));
    ({ hydrateSyncedSettings } = await fresh());
    await hydrateSyncedSettings();
    expect(h.sets).toContainEqual(["claude_context", JSON.stringify({ [SONNET]: 64_000 })]);
  });

  it("받으면 바로 이 기기 값이 되어 게이지 분모(claudeContextFor)가 다른 기기와 같아지고, 이 기기에만 있는 모델 값은 합쳐 다시 올린다", async () => {
    h.kv.set(K, JSON.stringify({ [SONNET]: 128_000, "claude-opus-5-5": 400_000 }));
    h.db.set("claude_context", JSON.stringify({ [SONNET]: 64_000, 망가진: "x" }));
    const { hydrateSyncedSettings, claudeContextFor, useSettingsStore } = await fresh();
    expect(claudeContextFor(SONNET)).toBe(128_000);
    await hydrateSyncedSettings();
    expect(claudeContextFor(SONNET)).toBe(64_000);
    expect(useSettingsStore.getState().claudeContext).toEqual({ [SONNET]: 64_000, "claude-opus-5-5": 400_000 });
    expect(JSON.parse(h.kv.get(K)!)).toEqual({ [SONNET]: 64_000, "claude-opus-5-5": 400_000 });
    expect(h.sets).toEqual([["claude_context", JSON.stringify({ [SONNET]: 64_000, "claude-opus-5-5": 400_000 })]]);
    // 다 같으면 다시 안 올린다(두 기기가 서로 주고받으며 돌지 않게)
    h.sets = [];
    await hydrateSyncedSettings();
    expect(h.sets).toEqual([]);
  });

  it("바꾸면 이 기기와 DB 둘 다에, 다른 창은 localStorage 알림으로 다시 읽는다", async () => {
    const { useSettingsStore } = await fresh();
    useSettingsStore.getState().setClaudeContext(SONNET, 64_000);
    await new Promise((ok) => setTimeout(ok, 0));
    expect(h.sets).toEqual([["claude_context", JSON.stringify({ [SONNET]: 64_000 })]]);
    window.dispatchEvent(Object.assign(new Event("storage"), { key: K, newValue: JSON.stringify({ [SONNET]: 128_000 }) }));
    expect(useSettingsStore.getState().claudeContext).toEqual({ [SONNET]: 128_000 });
  });
});

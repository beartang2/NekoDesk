// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  think: vi.fn(async (..._a: unknown[]) => ({ pick: "머그컵", why: "따뜻해 보여서", extra: { say: "그려 봤어" } })),
  drawGift: vi.fn(async () => ({ shape: { v: 1, parts: [{ t: "circle", x: 0, y: -4, r: 4, c: "red" }] } })),
}));
vi.mock("./neko-mind", () => ({
  think: m.think,
  loadMind: async () => ({ notes: [], topics: [] }),
  mindMaterial: () => ["## 지금\n재료"],
  recentInterests: async () => [],
  leaksFact: () => false,
}));
vi.mock("./gift-draw", () => ({ drawGift: m.drawGift }));
vi.mock("../api/tauri", () => ({
  memoryApi: { list: async () => [] },
  settingsApi: { get: async () => null, set: async () => {} },
  giftsApi: { add: async () => {}, patch: async () => {}, remove: async () => {} },
}));
vi.mock("../stores/settingsStore", async (orig) => ({ ...(await orig<typeof import("../stores/settingsStore")>()), isClaudeActive: () => true }));
vi.mock("../stores/claudeBudget", () => ({ budgetBlockReason: () => null }));

import { dayCap, framedOn, maybeDraw } from "./neko-drawing";
import { useNekoGifts } from "../neko/gifts";

describe("그릴 것 고르기(산책 주제와 같은 생각하기)", () => {
  it("갈래를 좁히지 않고 재료와 최근에 그린 것만 준다. 고른 것을 그려 액자로", async () => {
    useNekoGifts.setState({ gifts: [{ id: "f", at: "2026-11-20T00:00:00Z", title: "우산", body: "", shape: { v: 1, parts: [] }, frame: true }], loaded: true });
    expect(await maybeDraw()).toBe("머그컵");
    const [ask, material] = m.think.mock.calls[0] as [string, string[]];
    expect(ask).toContain("도형 몇 개");
    expect(ask).not.toMatch(/동물|꽃|음식|풍경|예:/);
    expect(material.join("\n")).toContain("## 최근에 그린 것\n- 우산(11/20)");
    expect(m.drawGift).toHaveBeenCalledWith("머그컵", "그려 봤어");
    expect(useNekoGifts.getState().gifts.slice(-1)[0]).toMatchObject({ title: "머그컵", body: "그려 봤어", frame: true });
  });
});

/** 맥·폰 합쳐 하루 1~2장(0.1.35 — 기기마다 2장씩 세 한 선물함에 하루 4장까지 쌓였다) */
describe("하루 그림 상한", () => {
  it("날짜로 1 또는 2를 정하고, 같은 날엔 같다", () => {
    const days = Array.from({ length: 30 }, (_, i) => new Date(2026, 10, 1 + i).toDateString());
    const caps = days.map(dayCap);
    expect(new Set(caps)).toEqual(new Set([1, 2]));
    expect(days.map(dayCap)).toEqual(caps);
  });

  it("다른 기기가 오늘 그린 액자가 상한만큼 선물함에 있으면 이 기기는 안 그린다", async () => {
    const today = new Date().toDateString();
    const art = (id: string, at: string) => ({ id, at, title: id, body: "", shape: { v: 1 as const, parts: [] }, frame: true as const });
    const now = new Date().toISOString();
    const gifts = Array.from({ length: dayCap(today) }, (_, i) => art(`폰${i}`, now));
    // 액자 아닌 선물·다른 날 액자는 안 센다
    expect(framedOn([...gifts, { ...art("어제", "2020-01-01T12:00:00Z") }, { at: now }], today)).toBe(gifts.length);

    useNekoGifts.setState({ gifts, loaded: true });
    m.think.mockClear();
    expect(await maybeDraw()).toBeNull();
    expect(m.think).not.toHaveBeenCalled();

    useNekoGifts.setState({ gifts: gifts.slice(1), loaded: true });
    expect(await maybeDraw()).toBe("머그컵");
  });
});

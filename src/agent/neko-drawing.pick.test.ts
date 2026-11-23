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
  noteChose: async () => {},
}));
vi.mock("./gift-draw", () => ({ drawGift: m.drawGift }));
vi.mock("../api/tauri", () => ({
  memoryApi: { list: async () => [] },
  settingsApi: { get: async () => null, set: async () => {} },
  giftsApi: { add: async () => {}, patch: async () => {}, remove: async () => {} },
}));
vi.mock("../stores/settingsStore", async (orig) => ({ ...(await orig<typeof import("../stores/settingsStore")>()), isClaudeActive: () => true }));
vi.mock("../stores/claudeBudget", () => ({ budgetBlockReason: () => null }));

import { maybeDraw } from "./neko-drawing";
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

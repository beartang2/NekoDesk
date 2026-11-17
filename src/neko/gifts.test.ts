// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
vi.mock("../api/tauri", () => ({
  settingsApi: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  },
}));

import { capGifts, freeSpot, useNekoGifts, type NekoGift } from "./gifts";

const gift = (id: string, placed?: number): NekoGift => ({
  id, at: "", title: id, body: "", shape: { v: 1, parts: [{ t: "circle", x: 0, y: -4, r: 4, c: "red" }] },
  ...(placed != null ? { placed: { surface: "floor", u: placed } } : {}),
});

beforeEach(() => {
  store.clear();
  useNekoGifts.setState({ gifts: [], loaded: false });
});

describe("선물함", () => {
  it("넘치면 놓이지 않은 것 중 오래된 것부터 뺀다", () => {
    const out = capGifts([gift("a", 0.5), gift("b"), gift("c"), gift("d")], 3);
    expect(out.map((g) => g.id)).toEqual(["a", "c", "d"]);
  });

  it("빈 자리는 이미 놓인 것들과 가장 먼 곳", () => {
    expect(freeSpot([])).toBe(0.35);
    expect(freeSpot([0.5])).toBe(0);
    expect(freeSpot([0, 1])).toBe(0.5);
  });

  it("놓기·치우기가 저장되고, 다시 불러오면 모양을 다시 검사한다", async () => {
    const s = useNekoGifts.getState();
    s.add({ id: "x", title: "도토리", body: "", shape: { parts: [{ t: "ellipse", x: 0, y: -5, rx: 4, ry: 5, c: "brown" }] } });
    useNekoGifts.getState().place("x", "auto");
    expect(useNekoGifts.getState().gifts[0].placed).toEqual({ surface: "floor", u: 0.35 });
    useNekoGifts.getState().place("x", null);
    expect(useNekoGifts.getState().gifts[0].placed).toBeUndefined();

    store.set("neko_gifts", JSON.stringify([{ id: "y", at: "", title: "망가짐", body: "", shape: { parts: "x" } }]));
    useNekoGifts.setState({ gifts: [], loaded: false });
    await useNekoGifts.getState().load();
    expect(useNekoGifts.getState().gifts[0].shape.parts[0].t).toBe("ellipse"); // 조약돌
  });
});

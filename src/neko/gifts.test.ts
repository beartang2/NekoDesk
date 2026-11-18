// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
vi.mock("../api/tauri", () => ({
  settingsApi: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  },
}));

import { capGifts, fits, freeSpot, smallestPlace, useNekoGifts, type NekoGift } from "./gifts";

const gift = (id: string, placed?: number): NekoGift => ({
  id, at: "", title: id, body: "", shape: { v: 1, parts: [{ t: "circle", x: 0, y: -4, r: 4, c: "red" }] },
  ...(placed != null ? { placed: { surface: "floor", u: placed, at: "dock" } } : {}),
});
const dot = { parts: [{ t: "circle", x: 0, y: -4, r: 4, c: "green" }] };

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

  it("벽에 건 자리(v)도 그대로 저장하고, 빈 바닥 자리를 찾을 땐 벽 물건은 안 센다", () => {
    const s = useNekoGifts.getState();
    s.add({ id: "w", title: "나뭇잎", body: "", shape: { parts: [{ t: "circle", x: 0, y: -4, r: 4, c: "green" }] } });
    s.add({ id: "f", title: "도토리", body: "", shape: { parts: [{ t: "circle", x: 0, y: -4, r: 4, c: "brown" }] } });
    useNekoGifts.getState().place("w", { surface: "wall", u: 0.35, v: 0.6 }, "dock");
    useNekoGifts.getState().place("f", "auto", "dock");
    const [w, f] = useNekoGifts.getState().gifts;
    expect(w.placed).toEqual({ surface: "wall", u: 0.35, v: 0.6, at: "dock" });
    expect(f.placed).toEqual({ surface: "floor", u: 0.35, at: "dock" }); // 벽 물건 자리는 비어 있는 셈
  });

  it("크기는 small·medium·large 만 남긴다(없으면 엔진이 medium)", () => {
    const s = useNekoGifts.getState();
    s.add({ id: "s", title: "s", body: "", shape: null, size: "large" });
    s.add({ id: "t", title: "t", body: "", shape: null, size: "huge" });
    expect(useNekoGifts.getState().gifts.map((g) => g.size)).toEqual(["large", undefined]);
  });

  it("노는 방식은 아는 것만 남긴다", () => {
    const s = useNekoGifts.getState();
    s.add({ id: "a", title: "a", body: "", shape: null, play: "roll" });
    s.add({ id: "b", title: "b", body: "", shape: null, play: "dance" });
    expect(useNekoGifts.getState().gifts.map((g) => g.play)).toEqual(["roll", undefined]);
  });

  it("놓기·치우기가 저장되고, 다시 불러오면 모양을 다시 검사한다", async () => {
    const s = useNekoGifts.getState();
    s.add({ id: "x", title: "도토리", body: "", shape: { parts: [{ t: "ellipse", x: 0, y: -5, rx: 4, ry: 5, c: "brown" }] } });
    useNekoGifts.getState().place("x", "auto", "dock");
    expect(useNekoGifts.getState().gifts[0].placed).toEqual({ surface: "floor", u: 0.35, at: "dock" });
    useNekoGifts.getState().place("x", null);
    expect(useNekoGifts.getState().gifts[0].placed).toBeUndefined();

    store.set("neko_gifts", JSON.stringify([{ id: "y", at: "", title: "망가짐", body: "", shape: { parts: "x" } }]));
    useNekoGifts.setState({ gifts: [], loaded: false });
    await useNekoGifts.getState().load();
    expect(useNekoGifts.getState().gifts[0].shape.parts[0].t).toBe("ellipse"); // 조약돌
  });

  it("장소마다 들어가는 크기: 방은 작은 것만, 거실은 중간까지, 마당은 다", () => {
    expect(["small", "medium", "large"].map((z) => fits(z as never, "sidebar"))).toEqual([true, false, false]);
    expect(["small", "medium", "large"].map((z) => fits(z as never, "dock"))).toEqual([true, true, false]);
    expect(["small", "medium", "large"].map((z) => fits(z as never, "screen"))).toEqual([true, true, true]);
    expect(fits(undefined, "sidebar")).toBe(false); // 크기 없음 = medium
    expect([smallestPlace("small"), smallestPlace(undefined), smallestPlace("large")]).toEqual(["sidebar", "dock", "screen"]);

    const s = useNekoGifts.getState();
    s.add({ id: "big", title: "big", body: "", shape: dot, size: "large" });
    useNekoGifts.getState().place("big", "auto", "dock"); // 안 들어간다
    expect(useNekoGifts.getState().gifts[0].placed).toBeUndefined();
    useNekoGifts.getState().place("big", "auto", "screen");
    expect(useNekoGifts.getState().gifts[0].placed?.at).toBe("screen");
  });

  it("다른 장소로 옮기고, 무대 안에서 끌면 장소는 그대로, 빈 자리는 장소마다 따로 센다", () => {
    const s = useNekoGifts.getState();
    s.add({ id: "a", title: "a", body: "", shape: dot, size: "small" });
    s.add({ id: "b", title: "b", body: "", shape: dot, size: "small" });
    useNekoGifts.getState().place("a", "auto", "sidebar");
    useNekoGifts.getState().place("b", "auto", "dock");
    // 방에 a 가 0.35 에 있어도 거실은 비어 있으니 b 도 0.35
    expect(useNekoGifts.getState().gifts.map((g) => g.placed)).toEqual([
      { surface: "floor", u: 0.35, at: "sidebar" }, { surface: "floor", u: 0.35, at: "dock" },
    ]);
    useNekoGifts.getState().place("a", { surface: "floor", u: 0.8 }); // 끌어 옮김: 장소 그대로
    expect(useNekoGifts.getState().gifts[0].placed).toEqual({ surface: "floor", u: 0.8, at: "sidebar" });
    useNekoGifts.getState().place("a", "auto", "dock"); // 거실로: b 와 먼 자리
    expect(useNekoGifts.getState().gifts[0].placed).toEqual({ surface: "floor", u: 1, at: "dock" });
  });

  it("장소가 생기기 전에 놓인 것은 크기가 들어가는 가장 작은 장소로 옮긴다", async () => {
    store.set("neko_gifts", JSON.stringify([
      { id: "s", at: "", title: "s", body: "", shape: dot, size: "small", placed: { surface: "floor", u: 0.2 } },
      { id: "m", at: "", title: "m", body: "", shape: dot, placed: { surface: "wall", u: 0.5, v: 0.5 } },
      { id: "l", at: "", title: "l", body: "", shape: dot, size: "large", placed: { surface: "floor", u: 0.7, at: "attic" } },
      { id: "k", at: "", title: "k", body: "", shape: dot, size: "large", placed: { surface: "floor", u: 0.1, at: "screen" } },
    ]));
    await useNekoGifts.getState().load();
    expect(useNekoGifts.getState().gifts.map((g) => g.placed?.at)).toEqual(["sidebar", "dock", "screen", "screen"]);
    expect(useNekoGifts.getState().gifts[1].placed).toEqual({ surface: "wall", u: 0.5, v: 0.5, at: "dock" });
  });
});

describe("선물 놀이 기록·장소별 엔진 목록", () => {
  it("갖고 논 때를 적고, 그 장소에 놓인 것만 엔진 모양으로(장소는 빼고 lastPlayed 는 넣고)", async () => {
    const { decorItems, PLAYS } = await import("./gifts");
    expect(PLAYS).toEqual(expect.arrayContaining(["scratch", "lean", "hide"]));
    const s = useNekoGifts.getState();
    s.add({ id: "a", title: "a", body: "", shape: dot, size: "small" });
    s.add({ id: "b", title: "b", body: "", shape: dot, size: "large" });
    useNekoGifts.getState().place("a", "auto", "sidebar");
    useNekoGifts.getState().place("b", "auto", "screen");
    useNekoGifts.getState().played("b", 1234);
    useNekoGifts.getState().played("nope", 1);
    const gifts = useNekoGifts.getState().gifts;
    expect(decorItems(gifts, "screen")).toEqual([
      expect.objectContaining({ id: "b", size: "large", lastPlayed: 1234, surface: "floor", u: 0.35 }),
    ]);
    expect(decorItems(gifts, "screen")[0]).not.toHaveProperty("at");
    expect(decorItems(gifts, "sidebar").map((d) => d.id)).toEqual(["a"]);
    expect(decorItems(gifts, "dock")).toEqual([]);
  });
});

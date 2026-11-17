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

  it("벽에 건 자리(v)도 그대로 저장하고, 빈 바닥 자리를 찾을 땐 벽 물건은 안 센다", () => {
    const s = useNekoGifts.getState();
    s.add({ id: "w", title: "나뭇잎", body: "", shape: { parts: [{ t: "circle", x: 0, y: -4, r: 4, c: "green" }] } });
    s.add({ id: "f", title: "도토리", body: "", shape: { parts: [{ t: "circle", x: 0, y: -4, r: 4, c: "brown" }] } });
    useNekoGifts.getState().place("w", { surface: "wall", u: 0.35, v: 0.6 });
    useNekoGifts.getState().place("f", "auto");
    const [w, f] = useNekoGifts.getState().gifts;
    expect(w.placed).toEqual({ surface: "wall", u: 0.35, v: 0.6 });
    expect(f.placed).toEqual({ surface: "floor", u: 0.35 }); // 벽 물건 자리는 비어 있는 셈
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

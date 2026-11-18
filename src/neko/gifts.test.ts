// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

const store = new Map<string, string>();
vi.mock("../api/tauri", () => ({
  settingsApi: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => void store.set(k, v)),
  },
}));

import { capGifts, freeSpot, scaleCapped, useNekoGifts, type NekoGift } from "./gifts";

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

  it("버리면 목록과 놓인 자리에서 빠지고, 다른 선물은 그대로다(다시 불러와도)", async () => {
    const { decorItems } = await import("./gifts");
    const s = useNekoGifts.getState();
    for (const id of ["a", "b", "c"]) s.add({ id, title: id, body: "", shape: dot });
    useNekoGifts.getState().place("a", "auto", "dock");
    useNekoGifts.getState().place("b", "auto", "dock");
    const before = useNekoGifts.getState().gifts.filter((g) => g.id !== "a");
    useNekoGifts.getState().remove("a");
    const ids = () => useNekoGifts.getState().gifts.map((g) => g.id);
    expect(ids()).toEqual(["b", "c"]);
    expect(useNekoGifts.getState().gifts).toEqual(before); // b 의 자리·c 는 그대로
    expect(decorItems(useNekoGifts.getState().gifts, "dock").map((d) => d.id)).toEqual(["b"]);
    useNekoGifts.setState({ gifts: [], loaded: false });
    await useNekoGifts.getState().load();
    expect(ids()).toEqual(["b", "c"]);
  });

  it("크기로 자리를 막지 않는다: 큰 것도 방에 놓이고, 너무 크면 그 자리에선 상한으로 그린다(저장값은 그대로)", () => {
    const s = useNekoGifts.getState();
    s.add({ id: "big", title: "big", body: "", shape: dot, size: "large" });
    useNekoGifts.getState().place("big", "auto", "sidebar");
    expect(useNekoGifts.getState().gifts[0].placed?.at).toBe("sidebar");
    useNekoGifts.getState().resize("big", 4, true);
    const g = useNekoGifts.getState().gifts[0];
    expect(g.scale).toBe(4);
    // 무대가 클수록 고양이·물건도 커서(S) 가장 큰 배율도 보통은 상한 안이다 — 상한은 안전망(decor-draw 테스트에서 건다)
    expect(scaleCapped(g, "sidebar")).toBe(false);
    expect(scaleCapped(g, "screen")).toBe(false);
  });

  it("배율: 0.25~4 로 묶고 1 이면 칸을 뺀다, 끄는 동안(save=false)은 저장 안 함, 놓으면 저장", async () => {
    useNekoGifts.getState().add({ id: "a", title: "a", body: "", shape: dot });
    await new Promise((r) => setTimeout(r, 0));
    const saved = () => JSON.parse(store.get("neko_gifts") ?? "[]")[0];
    useNekoGifts.getState().resize("a", 9, false);
    expect(useNekoGifts.getState().gifts[0].scale).toBe(4);
    expect(saved().scale).toBeUndefined();
    useNekoGifts.getState().resize("a", 0.1, true);
    await new Promise((r) => setTimeout(r, 0));
    expect(saved().scale).toBe(0.25);
    useNekoGifts.getState().resize("a", 1, true);
    await new Promise((r) => setTimeout(r, 0));
    expect("scale" in useNekoGifts.getState().gifts[0]).toBe(false);
    expect("scale" in saved()).toBe(false);
    store.set("neko_gifts", JSON.stringify([{ ...saved(), scale: 99 }]));
    useNekoGifts.setState({ gifts: [], loaded: false });
    await useNekoGifts.getState().load();
    expect(useNekoGifts.getState().gifts[0].scale).toBe(4); // 손댄 저장값도 묶는다
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
    expect(decorItems(gifts, "screen")[0].at).toBe("screen"); // 장소는 자리 상한(capPx)에 쓴다
    expect(decorItems(gifts, "sidebar").map((d) => d.id)).toEqual(["a"]);
    expect(decorItems(gifts, "dock")).toEqual([]);
  });
});

describe("모니터별 마당", () => {
  it("마당은 놓인 모니터를 적고, 그 모니터에 보이는 것만 엔진 모양으로(빠진 모니터·옛것은 주 모니터에)", async () => {
    const { decorItems } = await import("./gifts");
    const s = useNekoGifts.getState();
    for (const id of ["a", "b", "c", "d"]) s.add({ id, title: id, body: "", shape: dot, size: id === "d" ? "medium" : "large" });
    useNekoGifts.getState().place("a", "auto", "screen");          // 처음 놓기 + 모니터 안 줌 = 주 모니터(없음)
    useNekoGifts.getState().place("b", "auto", "screen", "L");     // 왼쪽 모니터
    useNekoGifts.getState().place("c", "auto", "screen", "GONE");  // 지금은 빠진 모니터
    useNekoGifts.getState().place("d", "auto", "dock", "L");       // 마당이 아니면 모니터는 버린다
    const g = () => useNekoGifts.getState().gifts;
    expect(g().map((x) => x.placed?.screen)).toEqual([undefined, "L", "GONE", undefined]);
    expect(g()[3].placed).toEqual({ surface: "floor", u: 0.35, at: "dock" });
    // 같은 모니터끼리만 빈 자리를 센다: a(주)·b(L)·c(GONE) 모두 첫 자리
    expect(g().slice(0, 3).map((x) => x.placed?.u)).toEqual([0.35, 0.35, 0.35]);
    const ids = (screen: string) => decorItems(g(), "screen", { id: screen, main: "M", known: ["M", "L"] }).map((x) => x.id);
    expect(ids("M")).toEqual(["a", "c"]); // 빠진 모니터의 것은 주 모니터에
    expect(ids("L")).toEqual(["b"]);
    expect(decorItems(g(), "screen").map((x) => x.id)).toEqual(["a", "b", "c"]); // 모니터를 안 주면 안 가린다
    expect(decorItems(g(), "screen", { id: "L", main: "M", known: ["M", "L"] })[0]).not.toHaveProperty("screen");
    // 끌어 옮김(모니터 안 줌): 모니터 그대로. 주 모니터에서 옮기면(주 모니터 id 를 줌) 그 id 로
    useNekoGifts.getState().place("b", { surface: "floor", u: 0.9 });
    expect(g()[1].placed).toEqual({ surface: "floor", u: 0.9, at: "screen", screen: "L" });
    useNekoGifts.getState().place("c", { surface: "floor", u: 0.2 }, undefined, "M");
    expect(g()[2].placed).toEqual({ surface: "floor", u: 0.2, at: "screen", screen: "M" });
    // 마당에서 거실로 옮기면 모니터는 버린다
    useNekoGifts.getState().place("d", "auto", "screen", "L");
    expect(g()[3].placed?.screen).toBe("L");
    useNekoGifts.getState().place("d", "auto", "dock");
    expect(g()[3].placed).not.toHaveProperty("screen");
  });
});

describe("액자", () => {
  it("'걸기'(auto)는 벽에, 같은 장소 벽에 건 것끼리 빈 자리를 찾는다", () => {
    const s = useNekoGifts.getState();
    s.add({ id: "p1", title: "튤립", body: "", shape: dot, size: "small", frame: true });
    s.add({ id: "p2", title: "우산", body: "", shape: dot, size: "small", frame: true });
    s.add({ id: "toy", title: "공", body: "", shape: dot, size: "small" });
    useNekoGifts.getState().place("p1", "auto", "sidebar");
    useNekoGifts.getState().place("toy", "auto", "sidebar");
    useNekoGifts.getState().place("p2", "auto", "sidebar");
    const [p1, p2, toy] = useNekoGifts.getState().gifts;
    expect(p1.frame).toBe(true);
    expect(p1.placed).toEqual({ surface: "wall", u: 0.35, v: 0.6, at: "sidebar" });
    expect(toy.placed).toEqual({ surface: "floor", u: 0.35, at: "sidebar" }); // 바닥은 따로 센다
    expect(p2.placed).toMatchObject({ surface: "wall", u: 1 });
  });

  it("마당에 걸면 화면 한가운데가 아니라 고양이 머리 조금 위에", () => {
    useNekoGifts.getState().add({ id: "p3", title: "해", body: "", shape: dot, size: "small", frame: true });
    useNekoGifts.getState().place("p3", "auto", "screen");
    expect(useNekoGifts.getState().gifts.find((g) => g.id === "p3")?.placed).toMatchObject({ surface: "wall", v: 0.13, at: "screen" });
  });
});


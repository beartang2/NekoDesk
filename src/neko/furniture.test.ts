// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 가구 저장(docs/neko-furniture.md §4·§6): 기본 다섯은 늘 있고, 칸에만 놓이고, 꽉 차면 거절, 치우면 다시 놓는다 */
const db = vi.hoisted(() => ({ kv: new Map<string, string>() }));
vi.mock("../api/tauri", () => ({
  settingsApi: { get: async (k: string) => db.kv.get(k) ?? null, set: async (k: string, v: string) => void db.kv.set(k, v) },
}));

import { BASE_FURNITURE, holdTops, orphansOnFurniture, parseFurniture, useNekoFurniture } from "./furniture";
import { furnitureSlots } from "./engine/decor-draw";

beforeEach(() => { db.kv.clear(); useNekoFurniture.setState({ items: BASE_FURNITURE, loaded: false }); });
const s = () => useNekoFurniture.getState();
const where = (id: string) => s().items.find((f) => f.id === id)?.place;

describe("가구 저장", () => {
  it("칸: 방 2·거실 4, 무대 폭을 똑같이 나눈 자리. 마당은 없다", () => {
    expect(furnitureSlots("sidebar", 280)).toEqual([{ x: 70, w: 140 }, { x: 210, w: 140 }]);
    expect(furnitureSlots("dock", 1100).map((x) => x.x)).toEqual([137.5, 412.5, 687.5, 962.5]);
    expect(furnitureSlots("screen", 1000)).toEqual([]);
  });

  it("기본 여섯(탁자 더함)은 처음부터 있고, 빈 칸에 놓고, 꽉 차면 거절, 마당은 못 놓는다", async () => {
    await s().load();
    expect(s().items.map((f) => f.id)).toEqual(["base:lamp", "base:cattower", "base:wheel", "base:sofa", "base:box", "base:table"]);
    expect(await s().place("base:sofa", "sidebar")).toBe(true);
    expect(await s().place("base:lamp", "sidebar")).toBe(true);
    expect(await s().place("base:box", "sidebar")).toBe(false); // 방은 2칸
    expect(await s().place("base:box", "screen")).toBe(false);
    expect(where("base:sofa")).toEqual({ at: "sidebar", slot: 0 });
    expect(where("base:lamp")).toEqual({ at: "sidebar", slot: 1 });
    await s().unplace("base:sofa");
    expect(where("base:sofa")).toBeNull();
    expect(await s().place("base:box", "sidebar")).toBe(true); // 치운 자리에 다시
    expect(where("base:box")).toEqual({ at: "sidebar", slot: 0 });
    expect(await s().place("base:lamp", "dock")).toBe(true); // 다른 장소로 옮기면 그 칸은 빈다
    expect(where("base:lamp")).toEqual({ at: "dock", slot: 0 });
  });

  it("고른 칸에 놓는다(선물함 칸 고르기): 찬 칸·없는 칸은 거절, 같은 장소 안에서 칸을 옮길 수 있다", async () => {
    await s().load();
    expect(await s().place("base:sofa", "dock", 2)).toBe(true);
    expect(where("base:sofa")).toEqual({ at: "dock", slot: 2 });
    expect(await s().place("base:lamp", "dock", 2)).toBe(false); // 찬 칸
    expect(await s().place("base:lamp", "dock", 4)).toBe(false); // 거실은 0~3
    expect(await s().place("base:lamp", "dock", 3)).toBe(true);
    expect(await s().place("base:sofa", "dock", 0)).toBe(true); // 같은 장소 안에서 옮김
    expect(where("base:sofa")).toEqual({ at: "dock", slot: 0 });
    expect(await s().place("base:sofa", "dock", 0)).toBe(true); // 제자리는 그대로
  });

  it("산책에서 물어온 가구는 더하고 버릴 수 있다(기본 가구는 못 버린다). 저장엔 놓인 기본 가구와 물어온 것만", async () => {
    await s().load();
    await s().add({ kind: "sofa", title: "등나무 의자", body: "공원 벤치 옆에서", found: "2026-11-20" });
    const walk = s().items.find((f) => f.title === "등나무 의자")!;
    expect(walk.id.startsWith("walk:")).toBe(true);
    await s().remove("base:sofa");
    expect(s().items.some((f) => f.id === "base:sofa")).toBe(true);
    await s().place(walk.id, "dock");
    const saved = JSON.parse(db.kv.get("neko_furniture")!).items as { id: string }[];
    expect(saved.map((f) => f.id)).toEqual([walk.id]);
    await s().remove(walk.id);
    expect(s().items.some((f) => f.id === walk.id)).toBe(false);
  });

  it("조명 켜짐은 그 가구 항목에 적고 at 을 바꾼다(맥·폰 같이). 같은 값이면 안 쓰고, 다른 기기 값(lamp)을 읽는다", async () => {
    await s().load();
    await s().place("base:lamp", "dock");
    const saved = () => (JSON.parse(db.kv.get("neko_furniture")!).items as { id: string; at: number; lamp?: boolean; place: unknown }[]).find((f) => f.id === "base:lamp")!;
    const t0 = saved().at;
    await s().setLamp("base:lamp", true);
    expect(saved()).toMatchObject({ lamp: true, place: { at: "dock", slot: 0 } });
    expect(saved().at).toBeGreaterThan(t0);
    expect(s().items[0].lamp).toBe(true);
    const t1 = saved().at, raw = db.kv.get("neko_furniture");
    await s().setLamp("base:lamp", true); // 같은 값: 안 쓴다(at 그대로)
    expect(db.kv.get("neko_furniture")).toBe(raw);
    await s().setLamp("base:lamp", false);
    expect("lamp" in saved()).toBe(false);
    expect(saved().at).toBeGreaterThan(t1); // 끈 것도 나중 바꿈 — 다른 기기의 켜짐을 이긴다
    expect(s().items[0].lamp).toBeUndefined();
    // 다른 기기가 켠 값을 받았다
    db.kv.set("neko_furniture", JSON.stringify({ v: 2, gone: {}, items: [{ id: "base:lamp", kind: "lamp", place: { at: "dock", slot: 0 }, lamp: true, at: saved().at + 5 }] }));
    await s().reload();
    expect(s().items[0].lamp).toBe(true);
    expect(parseFurniture(JSON.stringify({ v: 2, items: [{ id: "base:lamp", kind: "lamp", place: null, lamp: "yes" }] }))[0].lamp).toBeUndefined();
  });

  it("바꾼 가구엔 바꾼 때, 버린 가구는 버린 때를 적는다 — 다른 기기 값과 가구 하나씩 합치는 재료(sync/furniture.rs)", async () => {
    await s().load();
    await s().add({ kind: "box", title: "상자", found: "2026-11-20" });
    const id = s().items.find((f) => f.title === "상자")!.id;
    await s().place("base:lamp", "dock");
    const saved = () => JSON.parse(db.kv.get("neko_furniture")!) as { v: number; items: { id: string; at?: number; place: unknown }[]; gone: Record<string, number> };
    const lampAt = saved().items.find((f) => f.id === "base:lamp")!.at!;
    expect(saved().v).toBe(2);
    expect(lampAt).toBeGreaterThan(1);
    await s().unplace("base:lamp");
    // 치운 기본 가구도 남는다(다른 기기의 옛 놓기를 이긴다). 같은 ms 라도 앞 바꿈보다 늦다
    expect(saved().items.find((f) => f.id === "base:lamp")!.at!).toBeGreaterThan(lampAt);
    await s().remove(id);
    expect(saved().gone[id]).toBeGreaterThan(0);
    // 버린 뒤 바뀌지 않은 가구는 다른 기기 값에 남아 와도 안 보인다
    expect(parseFurniture(JSON.stringify({ v: 2, items: [{ id, kind: "box", place: null, at: 5 }], gone: { [id]: 9 } })).some((f) => f.id === id)).toBe(false);
  });

  it("두 기기가 같은 칸에 따로 놓았으면 먼저 놓은 것이 칸을 갖는다(어느 기기에서나 같게)", () => {
    const dock0 = { at: "dock", slot: 0 };
    const items = parseFurniture(JSON.stringify({ v: 2, items: [
      { id: "base:sofa", kind: "sofa", place: dock0, at: 30 },
      { id: "base:box", kind: "box", place: dock0, at: 20 },
    ], gone: {} }));
    expect(items.find((f) => f.id === "base:box")!.place).toEqual(dock0);
    expect(items.find((f) => f.id === "base:sofa")!.place).toBeNull();
  });

  it("옛 값(v 1)은 켤 때 한 번 v 2 로 다시 적는다 — 옛 가구는 아주 오래된 것(1)으로", async () => {
    db.kv.set("neko_furniture", JSON.stringify({ v: 1, items: [{ id: "base:sofa", kind: "sofa", place: { at: "dock", slot: 1 } }, { id: "walk:a", kind: "box", place: null, found: "2026-11-01" }] }));
    await s().load();
    const saved = JSON.parse(db.kv.get("neko_furniture")!) as { v: number; items: { id: string; at?: number }[] };
    expect(saved.v).toBe(2);
    expect(saved.items.map((f) => [f.id, f.at])).toEqual([["base:sofa", 1], ["walk:a", 1]]);
    expect(where("base:sofa")).toEqual({ at: "dock", slot: 1 });
  });

  it("망가진 값·모르는 종류·칸 밖·한 칸에 둘은 버리거나 비운다(옛·다른 기기 값)", () => {
    const items = parseFurniture(JSON.stringify({ v: 9, items: [
      { id: "base:sofa", kind: "sofa", place: { at: "dock", slot: 1 } },
      { id: "base:box", kind: "box", place: { at: "dock", slot: 1 } },
      { id: "base:lamp", kind: "lamp", place: { at: "screen", slot: 0 } },
      { id: "walk:x", kind: "piano", place: null },
      { id: "base:wheel", kind: "sofa", place: null },
    ] }));
    expect(items.find((f) => f.id === "base:sofa")!.place).toEqual({ at: "dock", slot: 1 });
    expect(items.find((f) => f.id === "base:box")!.place).toBeNull();
    expect(items.find((f) => f.id === "base:lamp")!.place).toBeNull();
    expect(items.some((f) => f.id === "walk:x")).toBe(false);
    expect(items.find((f) => f.id === "base:wheel")!.kind).toBe("wheel");
    expect(parseFurniture("{망가짐").length).toBe(6);
  });
});

describe("자유 가구(0.1.28, docs/neko-furniture-free.md §10)", () => {
  const rr = (x: number, y: number, w: number, h: number) => ({ t: "rrect", x, y, w, h, rad: 0, rot: 0, c: "brown" });
  const TABLE = { v: 1, parts: [rr(0, -10, 24, 2), rr(-10, -4.5, 2, 9), rr(10, -4.5, 2, 9)] };
  it("kind free 는 모양·쓰임새를 읽을 때 다시 검사해 싣고, 가구가 아닌 모양은 뺀다. 기본 id 로는 free 를 못 쓴다", () => {
    const raw = JSON.stringify({ v: 2, items: [
      { id: "walk:a", kind: "free", title: "나무 걸상", shape: TABLE, uses: [{ u: "perch", y: -13, x0: -6, x1: 9, soft: true }, { u: "bat", x: 0, y: -5 }], place: { at: "dock", slot: 2 }, at: 5 },
      { id: "walk:b", kind: "free", title: "납작", shape: { v: 1, parts: [rr(0, -1, 20, 2)] }, uses: [], place: null, at: 5 },
      { id: "base:free", kind: "free", shape: TABLE, place: null },
    ], gone: {} });
    const items = parseFurniture(raw).filter((f) => f.kind === "free");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: "walk:a", title: "나무 걸상", place: { at: "dock", slot: 2 }, uses: [{ u: "perch", y: -11, x0: -11.5, x1: 11.5, soft: true }] });
  });
  it("물어온 자유 가구를 더하면 모양·쓰임새가 저장되고, 다시 읽어도 같다", async () => {
    await s().load();
    await s().add({ kind: "free", title: "걸상", shape: TABLE as never, uses: [{ u: "perch", y: -11, x0: -11.5, x1: 11.5 }], found: "2026-11-23" });
    const stored = JSON.parse(db.kv.get("neko_furniture")!).items.find((f: { kind: string }) => f.kind === "free");
    expect(stored).toMatchObject({ kind: "free", uses: [{ u: "perch", y: -11 }] });
    const again = parseFurniture(db.kv.get("neko_furniture")!).find((f) => f.kind === "free");
    expect(again?.uses).toEqual(stored.uses);
    expect(await s().place(again!.id, "sidebar")).toBe(true);
  });
});

describe("이미 물어온 가구(0.1.27 까지 — 결정 A)", () => {
  const rr = (x: number, y: number, w: number, h: number) => ({ t: "rrect", x, y, w, h, rad: 0, rot: 0, c: "brown" });
  // 32칸에 꽉 찬 옛 소파 그림
  const OLD = { v: 1, parts: [rr(0, -12, 30, 8), rr(0, -5, 30, 6), rr(-14, -1, 2, 2), rr(14, -1, 2, 2)] };
  const raw = JSON.stringify({ v: 2, items: [{ id: "walk:o", kind: "sofa", title: "등나무 의자", shape: OLD, place: { at: "dock", slot: 0 }, at: 7 }], gone: {} });
  it("읽을 땐 자유 가구로 보인다 — 제 그림(고양이 키 12칸 축척으로 옮김)과 가장 넓은 면 하나만 올라앉기, 전용 동작 없음", () => {
    const f = parseFurniture(raw).find((x) => x.id === "walk:o")!;
    expect(f).toMatchObject({ kind: "free", title: "등나무 의자", place: { at: "dock", slot: 0 }, legacy: { kind: "sofa" } });
    expect(f.uses?.map((u) => u.u)).toEqual(["perch"]);
    expect(f.shape).not.toEqual(OLD);
  });
  it("저장은 원래 kind·모양 그대로(쓰임새 없이) — 옛 기기 값과 같은 때로 두 모양이 엇갈리지 않게", async () => {
    db.kv.set("neko_furniture", raw);
    await s().load();
    await s().place("base:lamp", "dock");
    const stored = JSON.parse(db.kv.get("neko_furniture")!).items.find((x: { id: string }) => x.id === "walk:o");
    expect(stored).toEqual({ id: "walk:o", kind: "sofa", title: "등나무 의자", shape: OLD, place: { at: "dock", slot: 0 }, at: 7 });
    expect(s().items.find((x) => x.id === "walk:o")?.kind).toBe("free");
  });
});

describe("가구 윗면(탁자·소파·캣타워·자유 가구 perch) 위 선물", () => {
  const T = (place: { at: "sidebar" | "dock"; slot: number } | null) => [{ id: "base:table", kind: "table" as const, place }, { id: "base:sofa", kind: "sofa" as const, place: { at: "dock" as const, slot: 0 } }, { id: "base:wheel", kind: "wheel" as const, place: { at: "dock" as const, slot: 3 } }];
  const on = (id: string, fid: string, at = "dock", i = 0) => ({ id, placed: { surface: "furniture", at, u: 0.4, fid, i, fu: 0.5 } });
  it("그 가구가 그 장소에 있고 그 면이 물건 얹는 면이면 그대로, 치웠거나 다른 장소·없는 면·얹지 않는 면(캣휠 레일)이면 바닥 u 로", () => {
    const gifts = [on("a", "base:table"), on("b", "base:table", "sidebar"), on("c", "base:sofa"), on("d", "walk:gone"), { id: "e", placed: { surface: "floor", at: "dock", u: 0.1 } }, on("f", "base:wheel"), on("g", "base:sofa", "dock", 1)];
    expect(orphansOnFurniture(gifts, T({ at: "dock", slot: 2 }))).toEqual([["b", 0.4], ["d", 0.4], ["f", 0.4], ["g", 0.4]]);
    expect(orphansOnFurniture(gifts, T(null)).map(([id]) => id)).toEqual(["a", "b", "d", "f", "g"]); // 탁자를 치웠다
  });
  it("얹는 면: 소파 방석·캣타워 발판 둘·탁자 윗면, 캣휠·조명·상자는 없다", () => {
    const at = (kind: "sofa" | "cattower" | "wheel" | "lamp" | "box" | "table") => holdTops([{ id: kind, kind, place: { at: "sidebar", slot: 0 } }], "sidebar", 280, 320, 320 / 240);
    expect(at("sofa").map((t) => t.i)).toEqual([0]);
    expect(at("cattower").map((t) => t.i)).toEqual([0, 1]);
    expect(at("table").map((t) => t.i)).toEqual([0]);
    expect([...at("wheel"), ...at("lamp"), ...at("box")]).toEqual([]);
  });
  it("자유 가구 perch 도 얹는다. 이 무대에서 고양이가 못 앉는(무대 위로 나가는) 면은 빼되 번호는 그대로", () => {
    const rr = (x: number, y: number, w: number, h: number) => ({ t: "rrect", x, y, w, h, rad: 0, rot: 0, c: "brown" });
    const shape = { v: 1, parts: [rr(0, -10, 24, 2), rr(-10, -4.5, 2, 9), rr(10, -4.5, 2, 9), rr(6, -30, 10, 2), rr(6, -20, 2, 18)] };
    const free = [{ id: "walk:f", kind: "free" as const, shape: shape as never, uses: [{ u: "perch" as const, y: -11, x0: -11, x1: 11 }, { u: "bat" as const, x: 0, y: -5 }, { u: "perch" as const, y: -31, x0: 1, x1: 11 }], place: { at: "dock" as const, slot: 1 } }];
    expect(holdTops(free, "dock", 760, 400, 1).map((t) => t.i)).toEqual([0, 1]); // 높은 거실: 둘 다
    expect(holdTops(free, "dock", 760, 200, 1).map((t) => t.i)).toEqual([0]); // 낮은 거실: 위 면은 고양이 머리가 무대 위로 나간다
    expect(orphansOnFurniture([on("x", "walk:f", "dock", 1), on("y", "walk:f", "dock", 2)], free)).toEqual([["y", 0.4]]); // perch 는 둘뿐
  });
  it("물건 얹는 윗면: 놓인 탁자 칸의 상판 위(엔진과 같은 칸·면 번호)", () => {
    const tops = holdTops(T({ at: "dock", slot: 1 }), "dock", 760, 164, 0.68).filter((t) => t.fid === "base:table");
    expect(tops).toHaveLength(1);
    expect(tops[0]).toMatchObject({ fid: "base:table", i: 0 });
    expect((tops[0].x0 + tops[0].x1) / 2).toBeCloseTo(285, 0); // 둘째 칸 가운데
    expect(164 - tops[0].y).toBeCloseTo(0.72 * 68, 0); // 상판 높이 = 고양이 키 0.72
  });
});

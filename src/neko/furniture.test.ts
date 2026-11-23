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

describe("가구 윗면(탁자) 위 선물", () => {
  const T = (place: { at: "sidebar" | "dock"; slot: number } | null) => [{ id: "base:table", kind: "table" as const, place }, { id: "base:sofa", kind: "sofa" as const, place: { at: "dock" as const, slot: 0 } }];
  const on = (id: string, fid: string, at = "dock", i = 0) => ({ id, placed: { surface: "furniture", at, u: 0.4, fid, i, fu: 0.5 } });
  it("탁자가 그 장소에 있으면 그대로, 치웠거나 다른 장소·면 없는 가구면 바닥 u 로", () => {
    const gifts = [on("a", "base:table"), on("b", "base:table", "sidebar"), on("c", "base:sofa"), on("d", "walk:gone"), { id: "e", placed: { surface: "floor", at: "dock", u: 0.1 } }];
    expect(orphansOnFurniture(gifts, T({ at: "dock", slot: 2 }))).toEqual([["b", 0.4], ["c", 0.4], ["d", 0.4]]);
    expect(orphansOnFurniture(gifts, T(null)).map(([id]) => id)).toEqual(["a", "b", "c", "d"]); // 탁자를 치웠다
  });
  it("물건 얹는 윗면: 놓인 탁자 칸의 상판 위(엔진과 같은 칸·면 번호)", () => {
    const tops = holdTops(T({ at: "dock", slot: 1 }), "dock", 760, 164, 0.68);
    expect(tops).toHaveLength(1);
    expect(tops[0]).toMatchObject({ fid: "base:table", i: 0 });
    expect((tops[0].x0 + tops[0].x1) / 2).toBeCloseTo(285, 0); // 둘째 칸 가운데
    expect(164 - tops[0].y).toBeCloseTo(0.72 * 68, 0); // 상판 높이 = 고양이 키 0.72
  });
});

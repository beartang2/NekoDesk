import { describe, it, expect } from "vitest";
import { roomWindows } from "./room-window.js";
import { TALL_DOCK_K, fallStep, capPx, decorAt, decorM, decorBoxes, decorDims, decorK, dragDecor, spotOf, hitDecorAt, sizeK, type DecorItem } from "./decor-draw.js";

const shape = { v: 1 as const, parts: [{ t: "circle" as const, x: 0, y: -8, r: 8, c: "red" as const }] };
const geom = { W: 1200, floorY: 600, S: 0.8 };

describe("decor-draw", () => {
  it("자리(비율) ↔ 무대 점이 서로 돌아온다(바닥·벽)", () => {
    const h = decorDims(shape, sizeK("large"), geom.S).h;
    for (const spot of [{ surface: "floor", u: 0.3 }, { surface: "wall", u: 0.7, v: 0.4 }] as const) {
      const [x, bottom] = decorAt(spot, h, geom);
      const back = spotOf(x, bottom, h, geom);
      expect(back.surface).toBe(spot.surface);
      expect(back.u).toBeCloseTo(spot.u, 6);
      if (spot.surface === "wall") expect((back as { v: number }).v).toBeCloseTo(spot.v, 6);
    }
  });

  it("누르기 판정은 그린 자리와 같다(엔진 setDecor 모양, scale 은 엔진처럼 0.35~1.4)", () => {
    const items: DecorItem[] = [{ id: "a", shape, size: "medium", surface: "floor", u: 0 }, { id: "b", shape, surface: "wall", u: 1, v: 1 }];
    const g = { W: 1200, floorY: 600, scale: 0.8 };
    const ha = decorDims(shape, 1, 0.8);
    const [ax, ab] = decorAt({ surface: "floor", u: 0 }, ha.h, geom);
    expect(hitDecorAt(items, g, ax, ab - ha.h / 2)).toBe("a");
    const [bx, bb] = decorAt({ surface: "wall", u: 1, v: 1 }, ha.h, geom);
    expect(hitDecorAt(items, g, bx, bb - ha.h / 2)).toBe("b");
    expect(hitDecorAt(items, g, 600, 300)).toBeNull();
    expect(hitDecorAt(items, { ...g, scale: 9 }, ax, ab - 1)).toBe("a"); // 배율은 1.4 로 묶인다
  });

  it("배율: 크기 × 사용자 배율, 자리 상한(방 80%·거실 띠와 고양이 키 1.92배·마당 고양이 키 3배)까지만 그린다", () => {
    const g = { floorY: 120, S: 0.8 }; // 폭이 좁아 S 는 크고 높이는 낮은 방
    expect(decorK(shape, "small", 1.5, "sidebar", g)).toEqual({ k: 0.6 * 1.5, capped: false });
    const room = decorK(shape, "large", 4, "sidebar", g);
    expect(room.capped).toBe(true);
    expect(decorDims(shape, room.k, g.S).h).toBeCloseTo(0.8 * 120, 6);
    expect(decorDims(shape, decorK(shape, "large", 4, "dock", g).k, g.S).h).toBeCloseTo(120, 6);
    // 거실은 방과 같은 고양이 대비(키의 1.92배)에서 멈춘다: 폰 가로(띠 369, S 1.4)·폰 세로(띠 114, S 0.475)·맥 거실(띠 164)·맥 방(194) 모두
    for (const geo of [{ floorY: 369, S: 1.4 }, { floorY: 114, S: 114 / 240 }, { floorY: 164, S: 164 / 240 }]) {
      expect(decorDims(shape, decorK(shape, "large", 3, "dock", geo).k, geo.S).h / (100 * geo.S)).toBeCloseTo(1.92, 6);
    }
    expect(decorDims(shape, decorK(shape, "large", 3, "sidebar", { floorY: 194, S: 194 / 240 }).k, 194 / 240).h / (100 * 194 / 240)).toBeCloseTo(1.92, 6);
    expect(decorK(shape, "large", 4, "screen", { floorY: 1000, S: 1 })).toEqual({ k: 300 / 96, capped: true }); // 배율은 3 까지, 마당은 고양이 키 3배(300)에서 멈춘다
    expect(decorK(shape, "large", 2, "screen", { floorY: 1000, S: 1 })).toEqual({ k: 2.9, capped: false });
    expect(capPx("screen", { floorY: 1000, S: 0.8 })).toBeCloseTo(240, 6);
    expect(decorK(shape, "small", 0.01, undefined, g).k).toBeCloseTo(0.6 * 0.5, 6); // 0.5(예전 기본 크기) 아래로는 안 줄인다
    expect(decorDims(shape, 1, 1).h).toBe(96); // 기본 한 변 96
    // 그리기·누르기도 같은 배율(선물 창)
    const items: DecorItem[] = [{ id: "a", shape, surface: "floor", u: 0.5, scale: 2, at: "dock" }];
    expect(decorBoxes(items, { W: 1200, floorY: 200, scale: 0.8 })[0].h).toBeCloseTo(decorDims(shape, 2, 0.8).h, 6);
  });

  it("선물 창 끌기: 칸은 그린 자리, 끌면 엔진처럼 무대 안으로 묶고 놓을 자리(벽·바닥)를 준다", () => {
    const items: DecorItem[] = [{ id: "a", shape, surface: "floor", u: 0.5 }];
    const g = { W: 1200, floorY: 600, scale: 0.8 }, h = decorDims(shape, 1, 0.8).h, m = 16 * 0.8;
    const [b] = decorBoxes(items, g);
    expect(b.id).toBe("a");
    expect(b.y + b.h).toBeCloseTo(600, 6); // 바닥 선물은 바닥에
    expect(hitDecorAt(items, g, b.x + b.w / 2, b.y + b.h / 2)).toBe("a");
    const low = dragDecor(items, g, "a", -50, 900)!; // 왼쪽 밖·바닥 아래 → 여백 안·바닥
    expect([low.x, low.bottom]).toEqual([m, 600]);
    expect(low.spot).toEqual({ surface: "floor", u: 0 });
    const high = dragDecor(items, g, "a", 900, -100)!; // 무대 위로 → 맨 위 벽
    expect(high.bottom).toBeCloseTo(h + 10 * 0.8, 6);
    expect(high.spot.surface).toBe("wall");
    expect((high.spot as { v: number }).v).toBeCloseTo(1, 6);
    expect(dragDecor(items, g, "nope", 0, 0)).toBeNull();
  });
  it("폰 가로 화면(고양이보다 높은 거실)에서만 선물을 고양이 대비 70% 로", () => {
    const ratio = (geo: { floorY: number; S: number }) => decorDims(shape, decorK(shape, "medium", 1, "dock", geo).k, geo.S).h / (100 * geo.S);
    const land = ratio({ floorY: 369, S: 1.4 }), port = ratio({ floorY: 114, S: 114 / 240 }), mac = ratio({ floorY: 164, S: 164 / 240 });
    expect(port).toBeCloseTo(mac, 6);
    expect(land / port).toBeCloseTo(TALL_DOCK_K, 6);
    expect(decorK(shape, "medium", 1, "sidebar", { floorY: 369, S: 1.4 }).k).toBe(1); // 방·마당은 그대로
  });

  it("벽에 건 선물은 날씨 창문(커튼·창턱까지)과 겹치면 창턱 아래로", () => {
    const g = { W: 812, floorY: 369, S: 1.4 }, h = 60, w = 60;
    const [win] = roomWindows("dock", 812, 375);
    // 왼쪽 창 한가운데쯤에 높이 건 것
    const u = (win.x + win.w / 2 - decorM(g.S)) / (g.W - 2 * decorM(g.S)), spot = { surface: "wall" as const, u, v: 0.95, at: "dock" };
    const [, bottom] = decorAt(spot, h, g, w);
    expect(bottom - h).toBeGreaterThanOrEqual(win.y + win.h + 6);
    expect(decorAt(spot, h, g)[1]).toBeLessThan(bottom); // 폭을 모르면 예전 자리
    // 창과 안 겹치는 자리(두 창 사이 가운데, 좁은 것)는 그대로
    const mid = { surface: "wall" as const, u: 0.5, v: 0.95, at: "dock" };
    expect(decorAt(mid, 20, g, 20)).toEqual(decorAt(mid, 20, g));
    // 마당엔 창이 없다
    expect(decorAt({ ...spot, at: "screen" }, h, g, w)).toEqual(decorAt({ ...spot, at: "screen" }, h, g));
  });

  it("떨어뜨리기(fallStep): 고양이와 같은 중력으로 바닥까지, 튕기고 멈춘다. 무대 밖으로 안 나간다", () => {
    const g = { W: 300, floorY: 194, S: 0.8 }, f = { x: 20, bottom: 40, vx: -400, vy: -100 };
    let t = 0, bounced = false, prevVy = 0;
    while (!fallStep(f, 1 / 120, g) && t < 5) { t += 1 / 120; if (prevVy > 0 && f.vy < 0) bounced = true; prevVy = f.vy; }
    expect(f.bottom).toBe(194);
    expect(bounced).toBe(true);
    expect(t).toBeLessThan(2);
    expect(f.x).toBeGreaterThanOrEqual(16 * 0.8);
  });
});

describe("가구 윗면(탁자) 위 자리", () => {
  const g = { W: 760, floorY: 164, S: 0.68, tops: [{ fid: "base:table", i: 0, x0: 250, x1: 320, y: 115 }] };
  it("물건 바닥이 윗면 근처면 그 위(면 위 비율 fu, 바로 아래 바닥 u), 멀면 바닥·벽", () => {
    const s = spotOf(285, 118, 20, g);
    expect(s).toMatchObject({ surface: "furniture", fid: "base:table", i: 0 });
    expect((s as { fu: number }).fu).toBeCloseTo(0.5, 2);
    expect(s.u).toBeCloseTo(spotOf(285, 164, 20, g).u, 6); // 옛 버전은 u 바닥에 둔다
    expect(spotOf(285, 164, 20, g).surface).toBe("floor");
    expect(spotOf(400, 118, 20, g).surface).toBe("wall"); // 탁자 밖 같은 높이는 벽
  });
  it("그 면이 있으면 면 위(면 안으로 묶음), 없으면 u 바닥", () => {
    const d = { surface: "furniture" as const, fid: "base:table", i: 0, fu: 1, u: 0.3 };
    const [x, y] = decorAt(d, 20, g, 30);
    expect(y).toBe(115);
    expect(x).toBeCloseTo(320 - 15, 6);
    expect(decorAt(d, 20, { ...g, tops: [] }, 30)).toEqual(decorAt({ surface: "floor", u: 0.3 }, 20, g, 30));
  });
});

describe("떨어진 액자(0.1.28)", () => {
  it("바닥의 액자는 옆으로 눕는다(칸 가로세로 바뀜, 바닥에 붙음), 끌어 들면 세운 모양", () => {
    const shape = { parts: [{ t: "rrect" as const, x: 0, y: -10, w: 26, h: 20, rad: 2, rot: 0, c: "blue" }] };
    const view = { W: 280, floorY: 320, scale: 1.12 };
    const [up] = decorBoxes([{ id: "a", surface: "floor", u: 0.5, size: "medium", shape }], view);
    const [lying] = decorBoxes([{ id: "a", surface: "floor", u: 0.5, size: "medium", shape, frame: true }], view);
    expect(lying.w).toBeCloseTo(up.h, 6);
    expect(lying.h).toBeCloseTo(up.w, 6);
    expect(lying.y + lying.h).toBeCloseTo(320, 6);
    const lifted = dragDecor([{ id: "a", surface: "floor", u: 0.5, size: "medium", shape, frame: true }], view, "a", 140, 200);
    expect(lifted?.spot.surface).toBe("wall"); // 들어 벽 높이에 놓으면 벽 자리
  });
});


import { describe, it, expect } from "vitest";
import { roomWindows, windowBox } from "./room-window.js";
import { TALL_DOCK_K, fallStep, capPx, decorAt, decorM, decorBoxes, decorDims, decorK, dragDecor, drawDecor, hungSpot, normRot, spotOf, hitDecorAt, sizeK, type DecorItem } from "./decor-draw.js";

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

  it("벽에 건 선물이 날씨 창문(그린 테두리: 커튼 봉·창턱까지)과 겹치면 네 방향 중 가장 가까운 쪽으로 비킨다", () => {
    const g = { W: 812, floorY: 369, S: 1.4 }, m = decorM(g.S);
    const [win] = roomWindows("dock", 812, 375), b = windowBox(win);
    expect(b).toEqual({ x0: win.x - 6, y0: win.y - 5, x1: win.x + win.w + 6, y1: win.y + win.h + 6 });
    const at = (x: number, bottom: number, h: number) => ({ surface: "wall" as const, u: (x - m) / (g.W - 2 * m), v: (g.floorY - bottom) / (g.floorY - h - 10 * g.S), at: "dock" });
    const near = (p: [number, number], q: [number, number]) => { expect(p[0]).toBeCloseTo(q[0], 6); expect(p[1]).toBeCloseTo(q[1], 6); };
    const mid = (b.y0 + b.y1) / 2 + 20;
    // 창 왼쪽 테두리에 조금 걸침 → 왼쪽으로(오른쪽 끝이 테두리에 맞닿게)
    near(decorAt(at(b.x0 + 5, mid, 40), 40, g, 40), [b.x0 - 20, mid]);
    // 오른쪽 테두리에 조금 걸침 → 오른쪽으로
    near(decorAt(at(b.x1 - 5, mid, 40), 40, g, 40), [b.x1 + 20, mid]);
    // 위 테두리에 조금 걸친 작은 것(위에 자리 있음) → 위로
    near(decorAt(at(win.x + win.w / 2, b.y0 + 4, 20), 20, g, 20), [win.x + win.w / 2, b.y0]);
    // 창턱에 조금 걸침 → 아래로(창턱에 맞닿게, 예전 3·S 여유 없음)
    near(decorAt(at(win.x + win.w / 2, b.y1 + 30, 40), 40, g, 40), [win.x + win.w / 2, b.y1 + 40]);
    // 테두리에 맞닿은 건 겹침이 아니다(바짝 붙여 건다)
    near(decorAt(at(b.x0 - 20, mid, 40), 40, g, 40), [b.x0 - 20, mid]);
    // 폭을 모르면 비키지 않는다
    expect(decorAt(at(b.x0 + 5, mid, 40), 40, g)[0]).toBeCloseTo(b.x0 + 5, 6);
    // 끌어 놓은 자리 저장(hungSpot): 비킨 자리의 비율 — 다시 그려도 그 자리(더 안 비킨다)
    const s = hungSpot(at(b.x0 + 5, mid, 40), 40, g, 40, "dock");
    near(decorAt({ ...s, at: "dock" }, 40, g, 40), [b.x0 - 20, mid]);
    expect(hungSpot({ surface: "floor", u: 0.3 }, 40, g, 40, "dock")).toEqual({ surface: "floor", u: 0.3 });
    // 창과 안 겹치는 자리(두 창 사이 가운데, 좁은 것)는 그대로. 마당엔 창이 없다
    const free = { surface: "wall" as const, u: 0.5, v: 0.95, at: "dock" };
    expect(decorAt(free, 20, g, 20)).toEqual(decorAt(free, 20, g));
    expect(decorAt({ ...at(b.x0 + 5, mid, 40), at: "screen" }, 40, g, 40)).toEqual(decorAt({ ...at(b.x0 + 5, mid, 40), at: "screen" }, 40, g));
  });

  it("창 비키기: 가까운 쪽이 벽 밖(무대 옆 끝·천장)이면 다음으로 가까운 쪽, 다 안 되면 창턱 아래", () => {
    const g = { W: 240, floorY: 320, S: 320 / 240 }, m = decorM(g.S);
    const [win] = roomWindows("sidebar", 240, 326), b = windowBox(win); // 방 창은 82%(stage-scale ROOM_K) — 폭 240 에서 왼쪽 끝 가까이
    const at = (x: number, bottom: number, h: number) => ({ surface: "wall" as const, u: (x - m) / (g.W - 2 * m), v: (g.floorY - bottom) / (g.floorY - h - 10 * g.S), at: "sidebar" });
    // 방 창은 왼쪽 끝 가까이: 왼쪽으로 밀면 무대 밖 → 위·아래·오른쪽 중 가까운 쪽(여기선 아래, 창 아래쪽에 걸친 것)
    const low = b.y1 + 2, [x1, y1] = decorAt(at(b.x0 + 8, low, 30), 30, g, 30);
    expect(8 + 15).toBeLessThan(b.y1 + 30 - low); // 왼쪽이 가장 가깝지만
    expect(b.x0 - 15 - 15).toBeLessThan(0); // 왼쪽 자리는 무대 밖
    expect(x1).toBeCloseTo(b.x0 + 8, 6);
    expect(y1).toBeCloseTo(b.y1 + 30, 6);
    // 위로 밀면 천장(무대 위 10·S) 넘는 큰 것: 위 테두리 근처여도 위로 안 간다
    const [, y2] = decorAt(at(win.x + win.w / 2, b.y0 + 6, 60), 60, g, 60);
    expect(y2).not.toBeCloseTo(b.y0, 3);
    // 넷 다 안 되는 아주 큰 것: 창턱 아래(바닥선까지)
    const [x3, y3] = decorAt(at(win.x + win.w / 2, (b.y0 + b.y1) / 2, 280), 280, g, 250);
    expect(x3).toBeCloseTo(win.x + win.w / 2, 6);
    expect(y3).toBe(g.floorY);
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
  it("누르기 칸(decorBoxes·hitDecorAt)도 면 위 — 보이는 자리에서 잡히고 아래 바닥에선 안 잡힌다(사용자: 탁자 위 물건을 집으면 바닥 위치로 잡힘)", () => {
    const shape = { parts: [{ t: "circle" as const, x: 0, y: -8, r: 8, c: "red" }] };
    const item = { id: "a", shape, size: "small" as const, surface: "furniture" as const, fid: "base:table", i: 0, fu: 0.5, u: 0.3 };
    const view = { W: 760, floorY: 164, scale: 0.68, tops: g.tops };
    const [b] = decorBoxes([item], view);
    expect(b.y + b.h).toBeCloseTo(115, 6); // 칸 바닥 = 상판
    expect(b.x + b.w / 2).toBeCloseTo(285, 6);
    expect(hitDecorAt([item], view, 285, 115 - b.h / 2)).toBe("a");
    const [fx] = decorAt({ surface: "floor", u: 0.3 }, b.h, g, b.w);
    expect(hitDecorAt([item], view, fx, 164 - b.h / 2)).toBeNull(); // 아래 바닥 자리
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


describe("놀다 멈춘 각도(placed.rot)", () => {
  it("normRot: (−π, π] 로 접고 0.01 로 반올림, 숫자가 아니면 0", () => {
    expect(normRot(0.123)).toBe(0.12);
    expect(normRot(1 + 6 * Math.PI)).toBe(1);
    expect(normRot(-1 - 2 * Math.PI)).toBe(-1);
    expect([normRot(undefined), normRot("1"), normRot(Number.NaN), normRot(Infinity), normRot(-0.001)]).toEqual([0, 0, 0, 0, 0]);
  });

  it("선물 창·빈 방 그림도 그 각도로 그린다(벽은 똑바로, 누운 액자는 rot 쪽으로 90°)", () => {
    const rots: number[] = [];
    const g: object = new Proxy({}, {
      get: (t: Record<string | symbol, unknown>, k) => (k in t ? t[k] : k === "rotate" ? (a: number) => rots.push(a) : () => g),
      set: (t, k, v) => { t[k] = v; return true; },
    });
    const cv = { width: 0, height: 0, getContext: () => g } as unknown as HTMLCanvasElement;
    const shape = { parts: [{ t: "rrect" as const, x: 0, y: -10, w: 26, h: 20, rad: 2, rot: 0, c: "blue" }] };
    const draw = (it: Partial<DecorItem>) => { rots.length = 0; drawDecor(cv, [{ id: "a", shape, size: "medium", ...it } as DecorItem], { W: 280, H: 320, floorY: 300, scale: 1 }); return rots.filter((r) => r !== 0); };
    expect(draw({ surface: "floor", u: 0.5, rot: 0.7 })).toEqual([0.7]);
    expect(draw({ surface: "floor", u: 0.5 })).toEqual([]);
    expect(draw({ surface: "wall", u: 0.5, v: 0.5, rot: 0.7 } as never)).toEqual([]);
    expect(draw({ surface: "floor", u: 0.5, rot: -1.57, frame: true })).toEqual([-Math.PI / 2]);
    expect(draw({ surface: "floor", u: 0.5, frame: true })).toEqual([Math.PI / 2]); // 옛 기기(각도 없음)는 오른쪽으로
  });
});

describe("들어 올린 물건의 압정", () => {
  it("벽 높이로 들면 걸리는 것(액자, 마당은 다)만 압정을 그린다 — 방·거실의 다른 물건은 놓으면 떨어지니 없다", () => {
    let arcs = 0;
    const g: object = new Proxy({}, {
      get: (t: Record<string | symbol, unknown>, k) => (k in t ? t[k] : k === "arc" ? () => { arcs++; } : () => g),
      set: (t, k, v) => { t[k] = v; return true; },
    });
    const cv = { width: 0, height: 0, getContext: () => g } as unknown as HTMLCanvasElement;
    const shape = { parts: [{ t: "rrect" as const, x: 0, y: -10, w: 20, h: 20, rad: 0, rot: 0, c: "blue" }] };
    const pins = (it: Partial<DecorItem>, high = true) => {
      arcs = 0;
      drawDecor(cv, [{ id: "a", shape, size: "medium", surface: "floor", u: 0.5, ...it } as DecorItem], { W: 280, H: 320, floorY: 300, scale: 1, drag: { id: "a", x: 140, bottom: high ? 150 : 300 } });
      return arcs;
    };
    expect(pins({ at: "sidebar" })).toBe(0);
    expect(pins({ at: "dock" })).toBe(0);
    expect(pins({ at: "sidebar", frame: true })).toBe(2); // 압정 = 동그라미 둘(머리·반짝임)
    expect(pins({ at: "screen" })).toBe(2);
    expect(pins({ at: "sidebar", frame: true }, false)).toBe(0); // 바닥 가까이면 압정 없음
    // 벽에 걸린 것(들지 않음)은 그대로 압정
    arcs = 0;
    drawDecor(cv, [{ id: "a", shape, size: "medium", surface: "wall", u: 0.5, v: 0.5, frame: true, at: "sidebar" } as DecorItem], { W: 280, H: 320, floorY: 300, scale: 1 });
    expect(arcs).toBe(2);
  });
});

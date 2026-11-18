import { describe, it, expect } from "vitest";
import { decorAt, decorDims, spotOf, hitDecorAt, sizeK, type DecorItem } from "./decor-draw.js";

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
});

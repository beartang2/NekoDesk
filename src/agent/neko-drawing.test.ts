// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { framed } from "./neko-drawing";
import { shapeBounds, type GiftShape } from "../neko/engine/gift-shape";

describe("네코 그림 액자", () => {
  it("액자·매트를 뒤에 깔고 그림을 줄여 안쪽 가운데에 넣는다", () => {
    const tulip: GiftShape = {
      v: 1,
      parts: [
        { t: "line", pts: [[0, 0], [0, -20]], w: 1, c: "green" },
        { t: "ellipse", x: 0, y: -24, rx: 5, ry: 7, rot: 0, c: "yellow" },
      ],
    };
    const f = framed(tulip);
    expect(f.parts.slice(0, 2).map((p) => [p.t, p.c])).toEqual([["rrect", "brown"], ["rrect", "white"]]);
    const art = { v: 1 as const, parts: f.parts.slice(2) };
    const b = shapeBounds(art);
    expect(b.w).toBeLessThanOrEqual(18 + 0.01);
    expect(b.x0 + b.x1).toBeCloseTo(0, 5); // 가로 가운데
    // 액자 안(바닥 0 ~ 위 -22) 매트 안쪽에 들어간다
    const ys = art.parts.flatMap((p) => ("pts" in p ? p.pts.map((q) => q[1]) : [p.y]));
    expect(Math.min(...ys)).toBeGreaterThan(-20);
    expect(Math.max(...ys)).toBeLessThan(-2);
  });

  it("도형이 많으면 엔진 상한(24) 안으로 자른다", () => {
    const many: GiftShape = { v: 1, parts: Array.from({ length: 30 }, (_, i) => ({ t: "circle" as const, x: i % 10 - 5, y: -4 - i % 5, r: 1, c: "red" as const })) };
    expect(framed(many).parts.length).toBe(24);
  });
});

import { describe, it, expect } from "vitest";
import { DEFAULT_SHAPE, validateShape } from "./gift-shape.js";

describe("validateShape", () => {
  it("멀쩡한 모양은 그대로 둔다", () => {
    const cap = { v: 1, parts: [{ t: "circle", x: 0, y: -4, r: 6, c: "gold" }, { t: "dot", x: -2, y: -7, c: "white" }] };
    expect(validateShape(cap)).toEqual(cap);
  });

  it("칸 밖 숫자는 자르고, 모르는 색은 회색, 모르는 도형은 버린다", () => {
    const got = validateShape({ parts: [
      { t: "circle", x: 99, y: 5, r: 999, c: "neon" },
      { t: "script", code: "alert(1)" },
      { t: "rrect", x: 0, y: -8, w: 10, h: 6, rad: 2, rot: 0, c: "blue" },
    ] });
    expect(got.parts).toEqual([
      { t: "circle", x: 16, y: 0, r: 16, c: "gray" },
      { t: "rrect", x: 0, y: -8, w: 10, h: 6, rad: 2, rot: 0, c: "blue" },
    ]);
  });

  it("도형은 12개까지, 다각형 꼭짓점은 10개까지(3개 미만은 버림)", () => {
    const many = Array.from({ length: 20 }, () => ({ t: "circle", x: 0, y: -4, r: 2, c: "red" }));
    expect(validateShape({ parts: many }).parts).toHaveLength(12);
    const poly = validateShape({ parts: [
      { t: "poly", pts: Array.from({ length: 15 }, (_, i) => [i - 7, -i]), c: "green" },
      { t: "poly", pts: [[0, 0], [1, -1]], c: "green" },
    ] });
    expect(poly.parts).toHaveLength(1);
    expect((poly.parts[0] as { pts: unknown[] }).pts).toHaveLength(10);
  });

  it("쓸 만한 도형이 없으면(비었거나 점뿐이거나 깨짐) 조약돌", () => {
    expect(validateShape(null)).toBe(DEFAULT_SHAPE);
    expect(validateShape({ parts: "x" })).toBe(DEFAULT_SHAPE);
    expect(validateShape({ parts: [{ t: "dot", x: 0, y: -2, c: "red" }] })).toBe(DEFAULT_SHAPE);
  });
});

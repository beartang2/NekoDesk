import { describe, it, expect } from "vitest";
import { DEFAULT_SHAPE, drawShape, validateShape } from "./gift-shape.js";

describe("validateShape", () => {
  it("멀쩡한 모양은 그대로 둔다", () => {
    const cap = { v: 1, parts: [
      { t: "circle", x: 0, y: -4, r: 6, c: "gold" },
      { t: "line", pts: [[-2, -6], [0, -8]], w: 0.6, c: "gold.dark" },
      { t: "dot", x: -2, y: -7, r: 0.5, c: "white.light" },
    ] };
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

  it("프로토타입 이름(constructor·toString·__proto__)은 색으로 치지 않는다", () => {
    for (const c of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(validateShape({ parts: [{ t: "circle", x: 0, y: -4, r: 4, c }] }).parts[0]).toMatchObject({ c: "gray" });
    }
  });

  it("도형은 24개까지, 다각형 꼭짓점은 24개까지(3개 미만은 버림), 둥글기 기본 1.2", () => {
    const many = Array.from({ length: 30 }, () => ({ t: "circle", x: 0, y: -4, r: 2, c: "red" }));
    expect(validateShape({ parts: many }).parts).toHaveLength(24);
    const poly = validateShape({ parts: [
      { t: "poly", pts: Array.from({ length: 30 }, (_, i) => [i / 2 - 7, -i / 2]), c: "green" },
      { t: "poly", pts: [[0, 0], [1, -1]], c: "green" },
    ] });
    expect(poly.parts).toHaveLength(1);
    expect(poly.parts[0]).toMatchObject({ round: 1.2 });
    expect((poly.parts[0] as { pts: unknown[] }).pts).toHaveLength(24);
  });

  it("색은 팔레트 이름에 .dark·.light 까지만 받는다", () => {
    const got = validateShape({ parts: ["red.dark", "red.light", "red.neon", "red.dark.x", "nope.dark"].map((c) => ({ t: "circle", x: 0, y: -4, r: 3, c })) });
    expect(got.parts.map((p) => p.c)).toEqual(["red.dark", "red.light", "red", "gray", "gray"]);
  });

  it("선·점만 있으면 조약돌", () => {
    expect(validateShape({ parts: [{ t: "line", pts: [[0, 0], [1, -4]], c: "red" }] })).toBe(DEFAULT_SHAPE);
  });

  it("쓸 만한 도형이 없으면(비었거나 점뿐이거나 깨짐) 조약돌", () => {
    expect(validateShape(null)).toBe(DEFAULT_SHAPE);
    expect(validateShape({ parts: "x" })).toBe(DEFAULT_SHAPE);
    expect(validateShape({ parts: [{ t: "dot", x: 0, y: -2, c: "red" }] })).toBe(DEFAULT_SHAPE);
  });
});

describe("빛(glow)", () => {
  const lamp = { parts: [{ t: "rrect", x: 0, y: -8, w: 10, h: 14, rad: 2, rot: 0, c: "orange" }] };

  it("팔레트 이름이면 남기고, 잘못된 색·프로토타입 이름·글자가 아닌 값은 버린다(회색으로 바꾸지 않는다)", () => {
    expect(validateShape({ ...lamp, glow: "yellow.light" }).glow).toBe("yellow.light");
    expect(validateShape({ ...lamp, glow: "gold" }).glow).toBe("gold");
    for (const glow of ["#ff0", "neon", "yellow.bright", "red.dark.x", "constructor", "toString", 3, null, {}]) {
      expect(validateShape({ ...lamp, glow })).not.toHaveProperty("glow");
    }
    expect(validateShape(lamp)).not.toHaveProperty("glow");
  });

  it("빛나는 물건은 둘레에 빛무리(radial gradient)를 도형보다 먼저 그리고, 아니면 안 그린다", () => {
    const log: string[] = [];
    const grad = { addColorStop: () => {} };
    const ctx = new Proxy({} as Record<string, unknown>, {
      get: (_, k: string) => (k === "createRadialGradient" ? () => { log.push("radial"); return grad; }
        : k === "createLinearGradient" ? () => { log.push("linear"); return grad; }
        : () => {}),
      set: () => true,
    }) as unknown as CanvasRenderingContext2D;
    drawShape(ctx, validateShape({ ...lamp, glow: "yellow" }), 50, 50, 2);
    expect(log).toEqual(["radial", "linear"]);
    log.length = 0;
    drawShape(ctx, validateShape(lamp), 50, 50, 2);
    expect(log).toEqual(["linear"]);
  });
});

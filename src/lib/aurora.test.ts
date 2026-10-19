import { describe, it, expect } from "vitest";
import { auroraTints } from "./aurora";

describe("auroraTints", () => {
  it("채도는 0.7~1.3 배, 색상은 ±50° 안에서, 이웃 자리끼리는 비슷하다", () => {
    const tint = auroraTints();
    let last = tint(0);
    for (let i = 1; i <= 100; i++) {
      const t = tint(i / 100);
      expect(t.chroma).toBeGreaterThanOrEqual(0.7);
      expect(t.chroma).toBeLessThanOrEqual(1.3);
      expect(Math.abs(t.hue)).toBeLessThanOrEqual(50);
      // 1% 옆 자리끼리 색상이 크게 튀지 않는다.
      expect(Math.abs(t.hue - last.hue)).toBeLessThan(8);
      last = t;
    }
  });
});

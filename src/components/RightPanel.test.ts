// @vitest-environment jsdom
import { it, expect } from "vitest";
import { springAt } from "./RightPanel";

it("스프링 체크는 0 에서 출발해 20% 넘쳤다가 1 에 선다 (reactbits bounce 0.2)", () => {
  expect(springAt(0)).toBeCloseTo(0, 5);
  const peak = Math.max(...Array.from({ length: 500 }, (_, i) => springAt(i / 1000)));
  expect(peak).toBeGreaterThan(1.17);
  expect(peak).toBeLessThan(1.23);
  expect(springAt(0.5)).toBe(1);
});

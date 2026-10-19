import { describe, it, expect } from "vitest";
import { blobs, edgePoint } from "./edge-flow";

describe("edgePoint", () => {
  it("움직이던 방향으로 이어 그어 나간 가장자리를 찾는다", () => {
    expect(edgePoint([900, 500], [10, -2], 1000, 800)).toEqual([1000, 480]);
    expect(edgePoint([500, 50], [1, -1], 1000, 800)).toEqual([550, 0]);
  });

  it("방향이 없으면 가장 가까운 가장자리", () => {
    expect(edgePoint([30, 400], [0, 0], 1000, 800)).toEqual([0, 400]);
    expect(edgePoint([500, 790], [0, 0], 1000, 800)).toEqual([500, 800]);
  });
});

describe("blobs", () => {
  it("네 변을 따라 덩이가 고르게 늘어서고 화면 안에 가운데가 놓인다", () => {
    const all = blobs(1710, 1112);
    for (const side of ["top", "right", "bottom", "left"] as const) {
      expect(all.filter((b) => b.side === side).length).toBeGreaterThanOrEqual(2);
    }
    for (const b of all) {
      expect(b.x).toBeGreaterThan(0);
      expect(b.x).toBeLessThan(1710);
      expect(b.y).toBeGreaterThan(0);
      expect(b.y).toBeLessThan(1112);
    }
  });
});

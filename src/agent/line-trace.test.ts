import { describe, expect, it } from "vitest";
import { traceLineArt } from "./line-trace";

/** 흰 200×200 에 칠하기. paint(x, y) 가 색을 주면 그 색으로. */
function image(paint: (x: number, y: number) => [number, number, number] | null) {
  const w = 200, h = 200, data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      if (c) data.set([...c, 255], (y * w + x) * 4);
    }
  return { width: w, height: h, data };
}

describe("traceLineArt", () => {
  // 가운데 (100,100) 반지름 60 의 굵기 6 먹선 고리 + (100,100) 반지름 14 의 꽉 찬 먹 점 + 회색 면
  const img = image((x, y) => {
    const r = Math.hypot(x - 100, y - 100);
    if (Math.abs(r - 60) <= 3 || r <= 14) return [20, 20, 20];
    if (r < 57 && r > 20) return [200, 200, 200];
    return null;
  });
  const t = traceLineArt(img);
  const S = 1536 / 200;

  it("먹선은 원본 자리를 지나는 경로로, 꽉 찬 점은 덩어리로 가른다", () => {
    expect(t.lines.length).toBeGreaterThan(0);
    for (const p of t.lines.flat()) {
      expect(Math.abs(Math.hypot(p[0] / S - 100, p[1] / S - 100) - 60)).toBeLessThan(2.5);
    }
    // 고리를 거의 다 덮는다 — 점들이 원둘레의 여러 방향에 퍼져 있다
    const dirs = new Set(t.lines.flat().map(([x, y]) => Math.round((Math.atan2(y / S - 100, x / S - 100) / Math.PI) * 4)));
    expect(dirs.size).toBeGreaterThanOrEqual(7);
    expect(t.blobs).toHaveLength(1);
    for (const p of t.blobs[0].points) expect(Math.hypot(p[0] / S - 100, p[1] / S - 100)).toBeLessThan(17);
    expect(t.blobs[0].color).toBe("#141414");
  });

  it("흰색·먹색을 뺀 주요 색을 준다", () => {
    expect(t.colors[0]).toBe("#C8C8C8");
  });

  it("면은 색과 둘레로, 큰 것부터 — 가장자리에 닿은 흰 바탕만 빼고, 먹선 자리까지 채워 틈이 없다", () => {
    // 회색 고리와, 그 안에 갇힌 흰 띠(점과 고리 사이). 갇힌 흰 면은 회색 위에 다시 깔려야 한다.
    expect(t.fills.map((f) => f.color)).toEqual(["#C8C8C8", "#FFFFFF"]);
    // 회색 고리(반지름 20~57)를 먹선(60)까지 덮는다
    const r = t.fills[0].points.map(([x, y]) => Math.hypot(x / S - 100, y / S - 100));
    expect(Math.max(...r)).toBeGreaterThan(58);
    expect(Math.min(...r)).toBeGreaterThan(55);
  });

  it("선이 겹친 자리는 덩어리가 아니라 선으로 남는다 — 거기서 선이 끊기지 않게", () => {
    const cross = traceLineArt(image((x, y) => (Math.abs(x - 100) <= 2 || Math.abs(y - 100) <= 2) && x > 20 && x < 180 && y > 20 && y < 180 ? [20, 20, 20] : null));
    expect(cross.blobs).toHaveLength(0);
    expect(cross.lines.length).toBeGreaterThanOrEqual(2);
  });

  it("진한 면(커피색, 밝기 ~107)은 먹선이 아니라 면이다 — 검은 선이 있으면 기준이 그만큼 내려간다", () => {
    const cup = traceLineArt(image((x, y) => {
      const r = Math.hypot(x - 100, y - 100);
      if (Math.abs(r - 60) <= 3) return [20, 20, 20];
      return r < 57 ? [144, 96, 72] : null;
    }));
    expect(cup.blobs).toHaveLength(0);
    expect(cup.fills.map((f) => f.color)).toEqual(["#906048"]);
  });

  it("갈림길(T)에서 곧게 이어지는 두 갈래는 한 획이다 — 곡선이 토막 나지 않게", () => {
    const t = traceLineArt(image((x, y) =>
      (Math.abs(y - 100) <= 2 && x > 20 && x < 180) || (Math.abs(x - 100) <= 2 && y > 100 && y < 180) ? [20, 20, 20] : null));
    const spans = t.lines.map((p) => Math.max(...p.map((q) => q[0])) - Math.min(...p.map((q) => q[0])));
    expect(Math.max(...spans) / S).toBeGreaterThan(140); // 가로선 전체(20~180)가 한 경로
    expect(t.lines).toHaveLength(2);
  });

  it("빈 그림은 빈 결과", () => {
    expect(traceLineArt(image(() => null))).toEqual({ lines: [], blobs: [], colors: [], fills: [] });
  });
});

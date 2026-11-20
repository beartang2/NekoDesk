import { describe, it, expect } from "vitest";
import { dreamCloud, drawDream } from "./dream-art.js";

/** 그리기 호출만 세는 가짜 캔버스 */
function fake() {
  const calls: string[] = [];
  const g = new Proxy({}, {
    get: (_t, k) => (k === "createLinearGradient" || k === "createRadialGradient" ? () => ({ addColorStop() {} }) : (...a: unknown[]) => { calls.push(String(k)); return a; }),
    set: () => true,
  }) as unknown as CanvasRenderingContext2D;
  return { g, calls };
}

describe("꿈 말풍선(0.1.25)", () => {
  it("구름은 머리 위, 바라보는 쪽으로 — 무대 끝 안으로 민다. 아주 작은 무대에서도 반지름 하한", () => {
    const a = dreamCloud(500, 150, 1, { face: 1, W: 1000, H: 240 }), b = dreamCloud(500, 150, 1, { face: -1, W: 1000, H: 240 });
    expect(a.cy).toBeLessThan(150 - 30);
    expect(a.cx).toBeGreaterThan(500);
    expect(b.cx).toBeLessThan(500);
    const edge = dreamCloud(5, 20, 1, { face: -1, W: 300, H: 200 });
    expect(edge.cx - edge.r * 1.3).toBeGreaterThan(0); // 옆 끝 안
    expect(edge.cy - edge.r).toBeGreaterThan(0); // 위 끝 안
    expect(dreamCloud(100, 90, 0.35).r).toBe(17); // 폰 세로 거실
  });

  it("k 0 이면 안 그리고, 점부터 나타나 구름·그림은 뒤에. 모양·가구 둘 다 그린다", () => {
    const shape = { v: 1, parts: [{ t: "circle", x: 0, y: -10, r: 10, c: "red" }] };
    let f = fake(); drawDream(f.g, 100, 100, 1, { k: 0, content: { shape } }); expect(f.calls).toHaveLength(0);
    f = fake(); drawDream(f.g, 100, 100, 1, { k: 0.2, content: { shape } });
    expect(f.calls.filter((c) => c === "fill").length).toBe(1); // 점 하나
    f = fake(); drawDream(f.g, 100, 100, 1, { k: 1, content: { shape } });
    expect(f.calls.filter((c) => c === "fill").length).toBeGreaterThan(3); // 점 둘 + 구름 + 그림
    f = fake(); drawDream(f.g, 100, 100, 1, { k: 1, content: { furniture: "sofa", accent: "#75a7ce" } });
    expect(f.calls.filter((c) => c === "fill").length).toBeGreaterThan(3);
  });
});

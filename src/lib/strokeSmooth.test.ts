import { describe, it, expect } from "vitest";
import { createSmoother, type Pt, type Seg } from "./strokeSmooth";

/** 조각을 곡선 위 점들로(2차 베지어) */
const along = (s: Seg, n = 8): Pt[] => Array.from({ length: n + 1 }, (_, i) => {
  const t = i / n, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
  return { x: a * s.from.x + b * s.ctrl.x + c * s.to.x, y: a * s.from.y + b * s.ctrl.y + c * s.to.y };
});

describe("그림판 손떨림 보정(strokeSmooth)", () => {
  it("곧게 긋는데 손이 ±2px 떨리면 그린 선의 떨림이 줄어든다", () => {
    const sm = createSmoother();
    const input = Array.from({ length: 40 }, (_, i) => ({ x: i * 4, y: 50 + (i % 2 ? 2 : -2) }));
    sm.start(input[0]);
    const drawn = input.slice(1).flatMap((p) => along(sm.move(p)!));
    const tail = drawn.slice(40); // 시작 몇 칸 지나서
    const spread = Math.max(...tail.map((p) => p.y)) - Math.min(...tail.map((p) => p.y));
    expect(spread).toBeLessThan(4 * 0.6); // 입력 떨림 폭 4px 의 60% 아래
  });

  it("조각이 이어진다(앞 조각 끝 = 다음 조각 시작) — 끊긴 선이 없다", () => {
    const sm = createSmoother();
    sm.start({ x: 0, y: 0 });
    const segs = [{ x: 10, y: 0 }, { x: 20, y: 5 }, { x: 30, y: 15 }].map((p) => sm.move(p)!);
    segs.push(sm.end()!);
    for (let i = 1; i < segs.length; i++) expect(segs[i].from).toEqual(segs[i - 1].to);
    expect(segs[0].from).toEqual({ x: 0, y: 0 });
  });

  it("손을 떼면 마지막 입력 점까지 그린다 — 빠르게 그은 짧은 선도 끝까지", () => {
    const sm = createSmoother();
    sm.start({ x: 0, y: 0 });
    sm.move({ x: 40, y: 0 });
    sm.move({ x: 80, y: 0 });
    expect(sm.end()!.to).toEqual({ x: 80, y: 0 });
  });

  it("약하다: 움직이는 손에서 펜 끝이 두 칸 안에 입력 거리의 80% 이상 따라붙는다", () => {
    const sm = createSmoother();
    sm.start({ x: 0, y: 0 });
    sm.move({ x: 100, y: 0 });
    const s = sm.move({ x: 100, y: 0 })!;
    expect(s.ctrl.x).toBeGreaterThanOrEqual(55); // 한 칸 뒤 펜 끝
    expect(sm.move({ x: 100, y: 0 })!.ctrl.x).toBeGreaterThanOrEqual(79); // 두 칸 뒤
  });

  it("누르고 떼기만(점 찍기)은 이어 그릴 게 없다, 획 밖의 움직임은 무시", () => {
    const sm = createSmoother();
    expect(sm.move({ x: 1, y: 1 })).toBeNull();
    sm.start({ x: 5, y: 5 });
    expect(sm.end()).toBeNull();
    expect(sm.end()).toBeNull();
  });
});

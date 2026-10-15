import { describe, it, expect } from "vitest";
import { createSwipeStepper } from "./swipe";

/** 손으로 밀 때 세기는 커졌다 흔들리고, 떼면 관성으로 잦아든다(16ms 간격). */
const SWIPE = [2, 5, 9, 14, 20, 26, 24, 30, 28];
const MOMENTUM = [26, 22, 18, 15, 12, 10, 8, 6, 5, 4, 3, 3, 2, 2, 1, 1];

function run(deltas: number[], gapMs = 16) {
  const step = createSwipeStepper(40, 200);
  const out: number[] = [];
  deltas.forEach((d, i) => {
    const r = step(d, i * gapMs);
    if (r) out.push(r);
  });
  return out;
}

describe("createSwipeStepper", () => {
  it("한 번 밀면 관성이 길어도 한 칸", () => {
    expect(run([...SWIPE, ...MOMENTUM])).toEqual([1]);
  });

  it("세게 밀다 손을 떼며 관성이 한 번 튀어도 한 칸", () => {
    const hard = [5, 15, 35, 60, 90, 110, 100, 70, 40, 20];
    const momentum = [60, 55, 48, 42, 36, 30, 25, 20, 16, 12, 9, 7, 5, 4, 3, 2, 2, 1];
    expect(run([...hard, ...momentum])).toEqual([1]);
  });

  it("관성 꼬리에 다음 손짓이 이어 붙어도 손짓마다 한 칸", () => {
    expect(run([...SWIPE, ...MOMENTUM.slice(0, 10), ...SWIPE, ...MOMENTUM])).toEqual([1, 1]);
  });

  it("관성 중에 반대로 밀면 바로 반대로 한 칸", () => {
    expect(run([...SWIPE, ...MOMENTUM.slice(0, 4), ...SWIPE.map((d) => -d)])).toEqual([1, -1]);
  });

  it("미는 동안 세기가 흔들려도 두 칸 넘지 않는다", () => {
    expect(run([2, 6, 14, 22, 30, 18, 26, 34, 20, 31, 40, 25, 38, ...MOMENTUM])).toEqual([1]);
  });

  it("휠이 끊기면 다시 넘길 수 있다", () => {
    const step = createSwipeStepper(40, 200);
    expect(step(100, 0)).toBe(1);
    expect(step(100, 100)).toBe(0);
    expect(step(100, 400)).toBe(1);
  });
});

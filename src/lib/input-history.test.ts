import { it, expect } from "vitest";
import { historyStep } from "./input-history";

const H = ["첫 번째", "두 번째", "세 번째"]; // 오래된 것부터

it("기록이 없으면 키를 가로채지 않는다", () => {
  expect(historyStep([], null, -1, "쓰던 것")).toBeNull();
});

it("↑ 는 최근 것부터 거슬러 올라간다", () => {
  const a = historyStep(H, null, -1, "쓰던 것")!;
  expect(a).toEqual({ pos: 0, text: "세 번째" });
  expect(historyStep(H, a.pos, -1, "쓰던 것")).toEqual({ pos: 1, text: "두 번째" });
});

it("가장 오래된 것에서 ↑ 는 제자리 — 빈 칸으로 넘어가지 않는다", () => {
  expect(historyStep(H, 2, -1, "쓰던 것")).toEqual({ pos: 2, text: "첫 번째" });
});

it("가장 최근에서 ↓ 는 쓰던 초안으로 돌아온다", () => {
  expect(historyStep(H, 0, 1, "쓰던 것")).toEqual({ pos: null, text: "쓰던 것" });
});

it("기록 밖에서 ↓ 는 가로채지 않는다", () => {
  expect(historyStep(H, null, 1, "쓰던 것")).toBeNull();
});

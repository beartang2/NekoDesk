// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { EMOJI_PROMPTS, pickPrompts, isCorrectGuess } from "./drawing-game";

describe("pickPrompts", () => {
  it("요청한 개수만큼, 중복 없이 준다", () => {
    const picked = pickPrompts(5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((p) => p.emoji)).size).toBe(5);
  });

  it("테이블보다 많이 달라고 하면 있는 만큼만", () => {
    expect(pickPrompts(999)).toHaveLength(EMOJI_PROMPTS.length);
  });

  it("매번 같은 순서로 나오지 않는다", () => {
    const runs = new Set(Array.from({ length: 20 }, () => pickPrompts(3).map((p) => p.emoji).join()));
    expect(runs.size).toBeGreaterThan(1);
  });
});

describe("isCorrectGuess", () => {
  const fox = { emoji: "🦊", names: ["여우"] };
  const snail = { emoji: "🐌", names: ["달팽이"] };

  it("별칭 중 하나와 같으면 정답", () => {
    expect(isCorrectGuess("여우", fox)).toBe(true);
    expect(isCorrectGuess("개", { emoji: "🐶", names: ["강아지", "개"] })).toBe(true);
  });

  it("두 글자 이상이면 부분 일치도 인정", () => {
    expect(isCorrectGuess("달팽", snail)).toBe(true);
    expect(isCorrectGuess("고양이인형", { emoji: "🐱", names: ["고양이"] })).toBe(true);
  });

  it("한 글자 부분 일치는 안 쳐준다", () => {
    // "달" 로 "달팽이" 를 맞춘 걸로 치면 한 글자 찍기가 통한다.
    expect(isCorrectGuess("달", snail)).toBe(false);
  });

  it("빈 추측과 다른 단어는 오답", () => {
    expect(isCorrectGuess("  ", fox)).toBe(false);
    expect(isCorrectGuess("너구리", fox)).toBe(false);
  });
});

describe("EMOJI_PROMPTS", () => {
  it("모든 제시어가 이모지와 한국어 이름을 갖는다", () => {
    for (const p of EMOJI_PROMPTS) {
      expect(p.emoji.length).toBeGreaterThan(0);
      expect(p.names.length).toBeGreaterThan(0);
      for (const n of p.names) expect(n).toMatch(/^[가-힣]+$/);
    }
  });

  it("이모지가 중복되지 않는다", () => {
    expect(new Set(EMOJI_PROMPTS.map((p) => p.emoji)).size).toBe(EMOJI_PROMPTS.length);
  });
});

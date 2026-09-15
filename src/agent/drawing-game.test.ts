// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { EMOJI_PROMPTS, pickPrompts, parseEmojiAnswer } from "./drawing-game";

describe("pickPrompts", () => {
  it("요청한 개수만큼, 중복 없이 준다", () => {
    const picked = pickPrompts(5);
    expect(picked).toHaveLength(5);
    expect(new Set(picked.map((p) => p.emoji)).size).toBe(5);
  });

  it("표보다 많이 달라고 하면 있는 만큼만", () => {
    expect(pickPrompts(999)).toHaveLength(EMOJI_PROMPTS.length);
  });

  it("매번 같은 순서로 나오지 않는다", () => {
    const runs = new Set(Array.from({ length: 20 }, () => pickPrompts(3).map((p) => p.emoji).join()));
    expect(runs.size).toBeGreaterThan(1);
  });
});

describe("parseEmojiAnswer", () => {
  it("이모지 하나만 왔을 때", () => {
    expect(parseEmojiAnswer("🏠")?.name).toBe("집");
  });

  it("말이 붙어 와도 골라낸다", () => {
    expect(parseEmojiAnswer("이건 🏠 집이에요!")?.name).toBe("집");
  });

  it("<think> 블록이 본문에 섞여 와도 답만 읽는다", () => {
    // reasoning-format 설정에 따라 서버가 이 블록을 그대로 흘려보낸다.
    expect(parseEmojiAnswer("<think>\n집 같기도 하고 🎩 같기도\n</think>\n\n🏠")?.name).toBe("집");
  });

  it("여러 개 오면 먼저 나온 것", () => {
    expect(parseEmojiAnswer("🐠 아니면 🐱")?.name).toBe("물고기");
  });

  it("생각이 닫히지 않은 채 잘리면 null", () => {
    // 고민하던 후보를 답으로 읽으면 안 된다.
    expect(parseEmojiAnswer("<think>\n🕯️ 인가 💡 인가... 아니면 🏠")).toBeNull();
  });

  it("표에 없는 이모지나 빈 답은 null", () => {
    expect(parseEmojiAnswer("🦖🌟🐟")).toBeNull();
    expect(parseEmojiAnswer("")).toBeNull();
    expect(parseEmojiAnswer("모르겠어요")).toBeNull();
  });
});

describe("EMOJI_PROMPTS", () => {
  it("모든 제시어가 이모지와 한국어 이름을 갖는다", () => {
    for (const p of EMOJI_PROMPTS) {
      expect(p.emoji.length).toBeGreaterThan(0);
      expect(p.name).toMatch(/^[가-힣]+$/);
    }
  });

  it("이모지가 중복되지 않는다", () => {
    expect(new Set(EMOJI_PROMPTS.map((p) => p.emoji)).size).toBe(EMOJI_PROMPTS.length);
  });

  it("다른 이모지의 부분 문자열인 이모지가 없다", () => {
    // parseEmojiAnswer 는 indexOf 로 찾는다. ⭐ 가 다른 이모지 안에 들어 있으면
    // 엉뚱한 답을 정답으로 읽는다.
    for (const a of EMOJI_PROMPTS) {
      for (const b of EMOJI_PROMPTS) {
        if (a !== b) expect(b.emoji.includes(a.emoji)).toBe(false);
      }
    }
  });
});

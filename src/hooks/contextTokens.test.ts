// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { contextTokensOf, parseMeta, serializeMeta } from "./useAgentLoop";

/** 밥 게이지 = 열린 대화의 남은 컨텍스트. 답에 토큰 수를 같이 적어 대화와 함께 다른 기기로 간다 */
describe("대화의 컨텍스트 토큰 수", () => {
  it("답과 같이 저장되고, 대화를 읽으면 마지막 답의 값을 쓴다", () => {
    const a = serializeMeta({ model: "m", contextTokens: 1200 })!;
    const b = serializeMeta({ model: "m", contextTokens: 3400 })!;
    expect(parseMeta(b).contextTokens).toBe(3400);
    expect(contextTokensOf([null, a, null, b, null])).toBe(3400); // 뒤의 질문(meta 없음)은 건너뛴다
    expect(contextTokensOf([null, serializeMeta({ model: "m" })])).toBeNull(); // 옛 답: 이 기기 값 그대로
    expect(contextTokensOf([])).toBeNull();
  });
});

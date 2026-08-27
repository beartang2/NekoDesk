import { describe, it, expect } from "vitest";
import { estimateMessagesTokens, estimateTokens } from "./token-estimate";

describe("estimateTokens", () => {
  it("빈 문자열은 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("한글은 영어보다 글자당 두 배 넘게 비싸다", () => {
    // 계수 비율 0.85/0.32 ≈ 2.7배. 이걸 한 계수로 뭉개면 한국어 대화에서
    // 예산을 크게 과소평가하게 된다.
    const korean = estimateTokens("가".repeat(100));
    const ascii = estimateTokens("a".repeat(100));
    expect(korean / ascii).toBeGreaterThan(2.5);
  });

  it("길이에 단조 증가한다", () => {
    expect(estimateTokens("안녕하세요 반갑습니다")).toBeGreaterThan(estimateTokens("안녕"));
  });

  it("섞인 문장도 두 계수를 합산한다", () => {
    const mixed = estimateTokens("hello 안녕");
    expect(mixed).toBeGreaterThan(estimateTokens("hello "));
    expect(mixed).toBeGreaterThan(estimateTokens("안녕"));
  });
});

describe("estimateMessagesTokens", () => {
  it("메시지마다 오버헤드를 더한다", () => {
    const one = estimateMessagesTokens([{ content: "a" }]);
    const two = estimateMessagesTokens([{ content: "a" }, { content: "a" }]);
    expect(two).toBeGreaterThan(one * 1.5);
  });

  it("tool_calls 도 비용에 포함한다", () => {
    const plain = estimateMessagesTokens([{ content: "" }]);
    const withCalls = estimateMessagesTokens([
      { content: "", tool_calls: [{ id: "a", function: { name: "todo.list", arguments: "{}" } }] },
    ]);
    expect(withCalls).toBeGreaterThan(plain);
  });

  it("이미지 파트를 무시하지 않는다 — 무시하면 예산이 조용히 터진다", () => {
    const text = estimateMessagesTokens([{ content: [{ type: "text", text: "설명" }] }]);
    const image = estimateMessagesTokens([
      { content: [{ type: "image_url", image_url: { url: "data:..." } }] },
    ]);
    expect(image).toBeGreaterThan(text * 10);
  });
});

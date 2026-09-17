import { describe, it, expect } from "vitest";
import { buildQuickPrompt } from "./quick-ask";

describe("buildQuickPrompt", () => {
  it("맥락이 없으면 질문 그대로", () => {
    expect(buildQuickPrompt({ text: "  오늘 날씨 어때 " })).toEqual({
      userText: "오늘 날씨 어때",
      displayText: "오늘 날씨 어때",
    });
  });

  it("맥락은 질문 뒤에 붙는다 — 긴 선택문이 질문을 밀어내지 않게", () => {
    const { userText } = buildQuickPrompt({ text: "요약해줘", selection: "긴 본문", app: "Safari" });
    expect(userText.startsWith("요약해줘")).toBe(true);
    expect(userText).toContain("[선택한 텍스트 (Safari)]\n긴 본문");
  });

  it("채팅에는 맥락을 한 줄 인용으로만 보여주고 모델에는 전부 보낸다", () => {
    const long = "줄\n".repeat(500);
    const { userText, displayText } = buildQuickPrompt({ text: "에러 원인?", clipboard: long });
    expect(userText).toContain(long.trim().slice(0, 50));
    const quote = displayText.split("\n").find((l) => l.startsWith("> 클립보드:"))!;
    expect(quote.length).toBeLessThan(100);
    expect(displayText.split("\n")).toHaveLength(3);
  });
});

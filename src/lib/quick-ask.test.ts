import { describe, it, expect } from "vitest";
import { buildQuickPrompt, isKorean } from "./quick-ask";

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

describe("버튼 일(요약·번역·설명)", () => {
  it("말풍선엔 고른 글만, 지시는 따로 — 프롬프트가 말풍선에 안 보인다", () => {
    const r = buildQuickPrompt({ text: "", action: "번역", selection: " Korean won climbs ", app: "Safari" });
    expect(r.displayText).toBe("Korean won climbs");
    expect(r.userText).toBe("Korean won climbs");
    expect(r.task?.label).toBe("번역");
  });

  it("번역 방향은 글을 보고 정한다", () => {
    const to = (selection: string) => buildQuickPrompt({ text: "", action: "번역", selection }).task!.system;
    expect(to("원화가 2년 만에 최고치로 올랐다")).toContain("영어로");
    expect(to("Korean won climbs to two-year high")).toContain("한국어로");
    expect(to("엔비디아 Nvidia 주가가 GPU 수요로 올랐다")).toContain("영어로");
  });

  it("인코딩된 글은 푼 글로 일한다 — 모델이 base64 를 지어내 번역하지 않게", () => {
    const decoded = { kind: "Base64", text: "Hello, 네코!" };
    const r = buildQuickPrompt({ text: "", action: "번역", selection: "SGVsbG8sIOuEpOy9lCE=", decoded });
    expect(r.userText).toBe("Hello, 네코!");
    expect(r.displayText).toBe("Hello, 네코!");
    const ask = buildQuickPrompt({ text: "이거 뭐야?", selection: "SGVsbG8sIOuEpOy9lCE=", decoded });
    expect(ask.userText).toContain("[선택한 텍스트를 Base64로 풀면]\nHello, 네코!");
  });

  it("긴 글은 말풍선에서만 줄인다", () => {
    const long = "가".repeat(2000);
    const r = buildQuickPrompt({ text: "", action: "요약", selection: long });
    expect(r.userText).toBe(long);
    expect(r.displayText.length).toBe(600);
  });

  it("isKorean — 영문 약어가 섞여도 한국어 문장은 한국어", () => {
    expect(isKorean("오늘 FOMC 회의")).toBe(true);
    expect(isKorean("The Fed 연준 held rates")).toBe(false);
    expect(isKorean("12345 !!")).toBe(false);
  });
});

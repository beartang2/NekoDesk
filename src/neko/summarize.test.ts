import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE } from "./nekoStore";
import { coatSwatch, summarizeAppearance } from "./summarize";

describe("summarizeAppearance", () => {
  it("털 색·무늬·눈·털·체형을 한 줄로", () => {
    expect(summarizeAppearance({ ...DEFAULT_APPEARANCE, patterns: ["tabby", "white"] })).toBe("크림 · 줄무늬 · 흰 반점 · 노란 눈 · 단모 · 보통 체형");
  });
  it("직접 고른 색은 그 색을 견본으로", () => {
    const a = { ...DEFAULT_APPEARANCE, coat: "custom" as const, color: "#5b8fd9" };
    expect(summarizeAppearance(a).startsWith("직접 고른 색")).toBe(true);
    expect(coatSwatch(a)).toBe("#5b8fd9");
    expect(coatSwatch(DEFAULT_APPEARANCE)).toBe("#ead2ac");
  });
});

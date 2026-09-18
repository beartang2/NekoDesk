import { describe, it, expect } from "vitest";
import { extensionOf, formatBytes } from "./Attachments";

describe("formatBytes", () => {
  it.each([
    [0, ""],
    [512, "512 B"],
    [2048, "2.0 KB"],
    [28_640, "28 KB"],
    [1_942_512, "1.9 MB"],
    [104_857_600, "100 MB"],
  ])("%i → %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe("extensionOf", () => {
  it("마지막 점 뒤를 소문자로", () => {
    expect(extensionOf("네코-백업-2026-09.ZIP")).toBe("zip");
    expect(extensionOf("report.final.pdf")).toBe("pdf");
  });

  it("점이 없거나 숨김 파일이면 빈 문자열", () => {
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf(".env")).toBe("");
  });
});

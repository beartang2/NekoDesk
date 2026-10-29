import { it, expect, describe } from "vitest";
import { clampResetDay, nextResetFor, periodStartFor, rollover } from "./claudeBudget";
import { estimateCostUsd } from "../lib/claude-models";

describe("주기 계산 — 크레딧은 결제일에 들어온다", () => {
  it("갱신일 당일부터 새 주기다", () => {
    expect(periodStartFor(new Date(2026, 9, 15), 15)).toBe("2026-10-15");
  });
  it("갱신일 전이면 지난달 갱신일부터다", () => {
    expect(periodStartFor(new Date(2026, 9, 14), 15)).toBe("2026-09-15");
  });
  it("1월의 갱신일 전은 작년 12월이다", () => {
    expect(periodStartFor(new Date(2027, 0, 3), 10)).toBe("2026-12-10");
  });
  it("29~31일은 28일로 친다", () => {
    expect(clampResetDay(31)).toBe(28);
    expect(clampResetDay(0)).toBe(1);
  });
  it("다음 갱신일", () => {
    expect(nextResetFor(new Date(2026, 9, 29), 1)).toBe("2026-11-01");
    expect(nextResetFor(new Date(2026, 11, 20), 15)).toBe("2027-01-15");
  });
  it("주기가 바뀌면 장부를 비운다", () => {
    const old = { periodStart: "2026-09-01", spentUsd: 30, inputTokens: 1, outputTokens: 1, requests: 1 };
    expect(rollover(old, new Date(2026, 9, 2), 1).spentUsd).toBe(0);
    expect(rollover(old, new Date(2026, 8, 30), 1)).toBe(old);
  });
});

describe("비용 계산", () => {
  it("Haiku 5.5 는 10만 토큰 이하면 0.1/0.5 요율", () => {
    expect(estimateCostUsd("claude-haiku-5-5", 100_000, 0)).toBeCloseTo(0.01, 6);
    expect(estimateCostUsd("claude-haiku-5-5", 0, 1_000_000)).toBeCloseTo(0.5, 6);
  });
  it("10만 토큰을 넘으면 그 요청 전체가 5배다", () => {
    expect(estimateCostUsd("claude-haiku-5-5", 100_001, 0)).toBeCloseTo(100_001 * 0.5 / 1_000_000);
  });
  it("모르는 모델은 가장 비싼 값으로 친다", () => {
    expect(estimateCostUsd("claude-unknown", 1_000_000, 0)).toBeCloseTo(4, 6);
  });
});

// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

import { getTool, searchFoundNothing } from "./tool-registry";
import { useSettingsStore } from "../stores/settingsStore";
import { useClaudeBudget } from "../stores/claudeBudget";
import { claudeUrl } from "../lib/claude-models";
import type { NativeSearchResult } from "./types";

const ddg = [{ title: "DDG", url: "https://ddg.example", snippet: "s" }];
const native: NativeSearchResult = {
  answer: "10월 28일에 A 가 나왔어.",
  sources: [{ title: "A 발표", url: "https://a.example", page_age: "October 28, 2026" }],
  searches: 2,
  input_tokens: 10_000,
  output_tokens: 500,
  errors: [],
};

const local = useSettingsStore.getState().llmUrl;
const search = getTool("web.search")!;

beforeEach(() => {
  invoke.mockReset();
  useClaudeBudget.setState({ usage: { ...useClaudeBudget.getState().usage, spentUsd: 0, requests: 0 } });
});
afterEach(() => useSettingsStore.setState({ llmUrl: local }));

it("로컬 모델은 예전대로 DuckDuckGo 검색만 쓴다", async () => {
  invoke.mockResolvedValue(ddg);
  expect(await search.execute({ query: "q" })).toEqual(ddg);
  expect(invoke).toHaveBeenCalledWith("web_search", { query: "q" });
  expect(invoke).not.toHaveBeenCalledWith("claude_web_search", expect.anything());
});

it("Claude 는 내장 웹 검색을 쓰고(모델은 Haiku 고정), 토큰값과 검색 횟수값을 장부에 적는다", async () => {
  useSettingsStore.setState({ llmUrl: claudeUrl("claude-opus-5-5") });
  invoke.mockImplementation(async (cmd: string) => (cmd === "claude_web_search" ? native : ddg));

  const r = await search.execute({ query: "AI news" });
  expect(r).toEqual(native);
  expect(invoke).toHaveBeenCalledWith("claude_web_search", expect.objectContaining({ model: "claude-haiku-5-5", query: "AI news" }));

  const summary = search.summarize(r);
  expect(summary).toContain("10월 28일에 A 가 나왔어.");
  expect(summary).toContain("https://a.example");
  expect(summary).toContain("October 28, 2026");

  const { usage } = useClaudeBudget.getState();
  // Haiku 5.5: 입력 $0.10/M, 출력 $0.50/M + 검색 2회 × $0.01
  expect(usage.spentUsd).toBeCloseTo(10_000 * 0.1 / 1e6 + 500 * 0.5 / 1e6 + 0.02, 6);
  expect(usage.requests).toBe(1);
});

it("내장 검색이 실패하면 DuckDuckGo 로 대신 찾고, 왜 바뀌었는지 결과에 적는다", async () => {
  useSettingsStore.setState({ llmUrl: claudeUrl("claude-haiku-5-5") });
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "claude_web_search") throw new Error("Claude 웹 검색 실패(400): web search is not enabled");
    return ddg;
  });

  const r = await search.execute({ query: "q" });
  const summary = search.summarize(r);
  expect(summary).toContain("내장 웹 검색 실패");
  expect(summary).toContain("https://ddg.example");
});

it("출처 없이 오류만 오면 실패로 보고 대신 찾되, 쓴 토큰은 장부에 남긴다", async () => {
  useSettingsStore.setState({ llmUrl: claudeUrl("claude-haiku-5-5") });
  invoke.mockImplementation(async (cmd: string) =>
    cmd === "claude_web_search" ? { ...native, sources: [], errors: ["too_many_requests"], searches: 0 } : ddg
  );

  const summary = search.summarize(await search.execute({ query: "q" }));
  expect(summary).toContain("too_many_requests");
  expect(useClaudeBudget.getState().usage.spentUsd).toBeGreaterThan(0);
});

it("0건 판정은 모든 결과 모양에 맞는다", () => {
  expect(searchFoundNothing([])).toBe(true);
  expect(searchFoundNothing(ddg)).toBe(false);
  expect(searchFoundNothing({ ...native, sources: [] })).toBe(true);
  expect(searchFoundNothing(native)).toBe(false);
  expect(searchFoundNothing({ fallback: "x", results: [] })).toBe(true);
});

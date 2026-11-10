// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class { onmessage: (e: unknown) => void = () => {}; } }));

import { getTool, searchFoundNothing } from "./tool-registry";
import { absorbSearch } from "./llm-transport";
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

/** Rust 의 claude_proxy 를 흉내 낸다: 한 번 부를 때마다 상태코드와 JSON 본문 하나를 돌려준다. */
function proxyAnswers(...answers: { status: number; body: unknown }[]) {
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd !== "claude_proxy") return ddg;
    const a = answers.shift() ?? { status: 500, body: { type: "error", error: { message: "no more" } } };
    const ch = args.onEvent as { onmessage: (e: unknown) => void };
    queueMicrotask(() => {
      ch.onmessage({ event: "head", data: { status: a.status, headers: [["content-type", "application/json"]] } });
      ch.onmessage({ event: "chunk", data: { text: JSON.stringify(a.body) } });
      ch.onmessage({ event: "end" });
    });
  });
}

/** Messages API 응답 하나. */
const reply = (content: unknown[], usage: Record<string, unknown>, stop_reason = "end_turn") => ({
  id: "m1", type: "message", role: "assistant", model: "claude-haiku-5-5", content, stop_reason, usage,
});
const results = (...items: { url: string; title: string; page_age?: string }[]) => ({
  type: "web_search_tool_result", tool_use_id: "s1",
  content: items.map((r) => ({ type: "web_search_result", encrypted_content: "x", ...r })),
});

beforeEach(() => {
  invoke.mockReset();
  useClaudeBudget.setState({ usage: { ...useClaudeBudget.getState().usage, spentUsd: 0, requests: 0 } });
});
afterEach(() => useSettingsStore.setState({ llmUrl: local }));

it("로컬 모델은 예전대로 DuckDuckGo 검색만 쓴다", async () => {
  invoke.mockResolvedValue(ddg);
  expect(await search.execute({ query: "q" })).toEqual(ddg);
  expect(invoke).toHaveBeenCalledWith("web_search", { query: "q" });
  expect(invoke).not.toHaveBeenCalledWith("claude_proxy", expect.anything());
});

it("Claude 는 내장 웹 검색을 쓰고(모델은 Haiku 고정), 토큰값과 검색 횟수값을 장부에 적는다", async () => {
  useSettingsStore.setState({ llmUrl: claudeUrl("claude-opus-5-5") });
  proxyAnswers({
    status: 200,
    body: reply(
      [results({ url: "https://a.example", title: "A 발표", page_age: "October 28, 2026" }), { type: "text", text: "10월 28일에 A 가 나왔어." }],
      { input_tokens: 10_000, output_tokens: 500, server_tool_use: { web_search_requests: 2 } },
    ),
  });

  const r = await search.execute({ query: "AI news" });
  expect(r).toEqual(native);
  const sent = JSON.parse(invoke.mock.calls.find(([cmd]) => cmd === "claude_proxy")![1].body);
  expect(sent.model).toBe("claude-haiku-5-5");
  expect(sent.messages[0].content).toBe("AI news");
  expect(sent.tools[0].type).toBe("web_search_20250305");

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
  proxyAnswers({ status: 400, body: { type: "error", error: { type: "invalid_request_error", message: "web search is not enabled" } } });

  const r = await search.execute({ query: "q" });
  const summary = search.summarize(r);
  expect(summary).toContain("내장 웹 검색 실패");
  expect(summary).toContain("https://ddg.example");
});

it("출처 없이 오류만 오면 실패로 보고 대신 찾되, 쓴 토큰은 장부에 남긴다", async () => {
  useSettingsStore.setState({ llmUrl: claudeUrl("claude-haiku-5-5") });
  proxyAnswers({
    status: 200,
    body: reply(
      [{ type: "web_search_tool_result", tool_use_id: "s1", content: { type: "web_search_tool_result_error", error_code: "too_many_requests" } }],
      { input_tokens: 100, output_tokens: 5 },
    ),
  });

  const summary = search.summarize(await search.execute({ query: "q" }));
  expect(summary).toContain("too_many_requests");
  expect(useClaudeBudget.getState().usage.spentUsd).toBeGreaterThan(0);
});

it("검색 응답에서 글·출처(같은 주소는 한 번)·사용량을 모으고, 멈춘 턴이면 이어 보내라고 한다", () => {
  const out: NativeSearchResult = { answer: "", sources: [], searches: 0, input_tokens: 0, output_tokens: 0, errors: [] };
  const more = absorbSearch(
    reply(
      [{ type: "text", text: "찾아볼게. " }, results({ url: "https://a.example", title: "A" }, { url: "https://a.example", title: "A again" }, { url: "https://b.example", title: "B" })],
      { input_tokens: 1200, output_tokens: 80, server_tool_use: { web_search_requests: 1 } },
      "pause_turn",
    ),
    out,
  );
  expect(more).toBe(true);
  expect(out.answer).toBe("찾아볼게. ");
  expect(out.sources.map((s) => s.url)).toEqual(["https://a.example", "https://b.example"]);
  expect([out.searches, out.input_tokens, out.output_tokens]).toEqual([1, 1200, 80]);
});

it("0건 판정은 모든 결과 모양에 맞는다", () => {
  expect(searchFoundNothing([])).toBe(true);
  expect(searchFoundNothing(ddg)).toBe(false);
  expect(searchFoundNothing({ ...native, sources: [] })).toBe(true);
  expect(searchFoundNothing(native)).toBe(false);
  expect(searchFoundNothing({ fallback: "x", results: [] })).toBe(true);
});

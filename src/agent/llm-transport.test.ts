// @vitest-environment jsdom

import { it, expect, beforeEach, vi, describe } from "vitest";

/** Rust 쪽 claude_chat 을 흉내 낸다. 테스트마다 어떤 사건을 흘릴지 정한다. */
type Ev = { event: string; data?: unknown };
const script = vi.hoisted(() => ({
  /** 요청 순서대로. 각 요청에 흘릴 사건 목록. 하나만 있으면 되풀이한다. */
  rounds: [] as Ev[][],
  hasKey: true,
  sent: [] as Array<Record<string, unknown>>,
}));
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (ev: T) => void = () => {};
  }
  return { invoke, Channel };
});

import { explainClaudeError, llmFetch, __rawTurnsForTest } from "./llm-transport";
import { useSettingsStore, setServerToolCaps } from "../stores/settingsStore";
import { useClaudeBudget } from "../stores/claudeBudget";

const sse = (events: Array<Record<string, unknown>>) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** 본문 하나와 usage 를 내는 평범한 응답. */
const plainReply = (text = "야옹", usage: Record<string, unknown> = {}): Ev[] => [
  { event: "head", data: { status: 200 } },
  { event: "chunk", data: { text: sse([
    { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1, ...usage } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } },
    { type: "message_stop" },
  ]) } },
  { event: "end" },
];

const post = (body: Record<string, unknown>, signal?: AbortSignal) =>
  llmFetch("/v1/chat/completions", { method: "POST", body: JSON.stringify(body), signal });

beforeEach(() => {
  localStorage.clear();
  script.rounds = [];
  script.hasKey = true;
  script.sent = [];
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "secret_has") return script.hasKey;
    if (cmd === "claude_chat") {
      script.sent.push(JSON.parse(args.body as string));
      const events = script.rounds.length > 1 ? script.rounds.shift()! : script.rounds[0] ?? [];
      const ch = args.onEvent as { onmessage: (e: Ev) => void };
      // 실제 채널처럼 커맨드가 돌아온 뒤에 사건이 도착한다.
      queueMicrotask(() => events.forEach((e) => ch.onmessage(e)));
      return undefined;
    }
    return undefined;
  });
  useSettingsStore.getState().setLlmUrl("claude://claude-haiku-5-5");
  setServerToolCaps("claude-haiku-5-5", { web_search: false, web_fetch: false });
  useClaudeBudget.getState().setSettings({ budgetUsd: 80, resetDay: 1 });
  useClaudeBudget.setState((s) => ({ usage: { ...s.usage, spentUsd: 0, requests: 0, inputTokens: 0, outputTokens: 0 } }));
});

describe("explainClaudeError", () => {
  it("크레딧 소진은 결제일을 기다리면 된다고 알려준다", () => {
    const raw = '{"error":{"message":"Your credit balance is too low to access the Anthropic API."}}';
    expect(explainClaudeError(400, raw)).toMatch(/크레딧이 바닥났어/);
  });
  it("401 은 키 문제다", () => {
    expect(explainClaudeError(401, "invalid x-api-key")).toMatch(/키가 맞지 않아/);
  });
  it("모르는 오류는 원문을 그대로 보인다", () => {
    expect(explainClaudeError(400, "messages: bad")).toBe("messages: bad");
  });
});

describe("llmFetch (Claude 프로필, 네이티브 Messages API)", () => {
  it("Messages 본문으로 보내고, 번역된 스트림을 돌려주고, 사용액을 캐시 요율로 적는다", async () => {
    script.rounds = [plainReply("야옹", { input_tokens: 1000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 1000 })];
    const res = await post({ messages: [{ role: "system", content: "고양이" }, { role: "user", content: "hi" }], stream: true, temperature: 0.3, neko_effort: "low" });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("야옹");
    expect(text.trim().endsWith("data: [DONE]")).toBe(true);

    const sent = script.sent[0];
    expect(sent.model).toBe("claude-haiku-5-5");
    expect(sent.system).toBe("고양이");
    expect(sent.temperature).toBeUndefined();
    expect(sent.cache_control).toEqual({ type: "ephemeral" });
    expect(sent.output_config).toEqual({ effort: "low" });

    // 1000 fresh × 0.1 + 8000 read × 0.01 + 1000 write × 0.125 + 10 out × 0.5 (/1M)
    const u = useClaudeBudget.getState().usage;
    expect(u.requests).toBe(1);
    expect(u.spentUsd).toBeCloseTo((1000 * 0.1 + 8000 * 0.01 + 1000 * 0.125 + 10 * 0.5) / 1e6, 9);
    expect(u.inputTokens).toBe(10000);
  });

  it("비스트리밍 호출은 JSON 한 덩이로", async () => {
    script.rounds = [plainReply("대체")];
    const res = await post({ messages: [{ role: "user", content: "?" }], stream: false });
    const data = await res.json() as { choices: Array<{ message: { content: string } }>; usage: { prompt_tokens: number } };
    expect(data.choices[0].message.content).toBe("대체");
    expect(data.usage.prompt_tokens).toBe(100);
  });

  it("HTTP 오류는 사람이 읽을 말로 바꿔 같은 상태코드로 돌려준다", async () => {
    script.rounds = [[
      { event: "head", data: { status: 400 } },
      { event: "chunk", data: { text: '{"error":{"message":"Your credit balance is too low"}}' } },
      { event: "end" },
    ]];
    const res = await post({ messages: [{ role: "user", content: "?" }], stream: true });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/크레딧이 바닥났어/);
  });

  it("응답 전에 실패하면(키 없음) 거절한다", async () => {
    script.rounds = [[{ event: "error", data: { message: "Claude API 키가 없어." } }]];
    await expect(post({ messages: [{ role: "user", content: "?" }] })).rejects.toThrow(/키가 없어/);
  });

  it("예산을 다 썼으면 보내지도 않는다", async () => {
    useClaudeBudget.setState((s) => ({ usage: { ...s.usage, spentUsd: 80 } }));
    await expect(post({})).rejects.toThrow(/예산/);
    expect(invoke).not.toHaveBeenCalledWith("claude_chat", expect.anything());
  });

  it("멈추면 Rust 쪽 요청도 끊는다", async () => {
    script.rounds = [[{ event: "head", data: { status: 200 } }, { event: "chunk", data: { text: sse([
      { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "시작" } },
    ]) } }]];
    const ctl = new AbortController();
    const res = await post({ messages: [{ role: "user", content: "?" }], stream: true }, ctl.signal);
    const reading = res.text();
    ctl.abort();
    await expect(reading).rejects.toThrow();
    expect(invoke).toHaveBeenCalledWith("claude_cancel", expect.objectContaining({ id: expect.any(String) }));
  });

  it("pause_turn 이면 받은 assistant 블록을 그대로 되돌려 보내 이어 간다", async () => {
    const first: Ev[] = [
      { event: "head", data: { status: 200 } },
      { event: "chunk", data: { text: sse([
        { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":\"q\"}" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ type: "web_search_result", title: "T", url: "https://t.example", encrypted_content: "ENC" }] } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ]) } },
      { event: "end" },
    ];
    script.rounds = [first, plainReply(" 결과야")];
    const res = await post({ messages: [{ role: "user", content: "검색" }], stream: true });
    const text = await res.text();
    expect(text).toContain("결과야");
    expect(script.sent).toHaveLength(2);
    const second = script.sent[1].messages as Array<{ role: string; content: unknown[] }>;
    expect(second[1].role).toBe("assistant");
    expect(second[1].content).toEqual([
      { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "q" } },
      expect.objectContaining({ type: "web_search_tool_result", content: [expect.objectContaining({ encrypted_content: "ENC" })] }),
    ]);
  });

  it("툴 호출 턴의 원본(thinking signature)을 기억해 두고 다음 요청에서 그대로 보낸다", async () => {
    script.rounds = [[
      { event: "head", data: { status: 200 } },
      { event: "chunk", data: { text: sse([
        { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_7", name: "todo__list", input: {} } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } },
        { type: "message_stop" },
      ]) } },
      { event: "end" },
    ]];
    await (await post({ messages: [{ role: "user", content: "할 일" }], stream: true })).text();
    expect(__rawTurnsForTest.lookup(["toolu_7"])).toEqual([
      { type: "thinking", thinking: "", signature: "SIG" },
      { type: "tool_use", id: "toolu_7", name: "todo__list", input: {} },
    ]);

    script.rounds = [plainReply("우유 사기")];
    await (await post({ messages: [
      { role: "user", content: "할 일" },
      { role: "assistant", content: "", tool_calls: [{ id: "toolu_7", type: "function", function: { name: "todo.list", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "toolu_7", content: "- 우유" },
    ], stream: true })).text();
    const msgs = script.sent[1].messages as Array<{ role: string; content: unknown[] }>;
    expect(msgs[1].content[0]).toEqual({ type: "thinking", thinking: "", signature: "SIG" });
    expect(msgs[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_7" });
  });

  it("모델이 서버 툴을 지원한다고 확인되면 요청에 붙인다", async () => {
    setServerToolCaps("claude-haiku-5-5", { web_search: true, web_fetch: true });
    script.rounds = [plainReply()];
    await (await post({ messages: [{ role: "user", content: "?" }], stream: true })).text();
    const tools = script.sent[0].tools as Array<{ name: string; type: string }>;
    expect(tools.map((t) => t.name)).toEqual(["web_search", "web_fetch"]);
    expect(tools[0].type).toBe("web_search_20250305");
  });

  it("모델 목록은 키가 있을 때만 살아 있다고 답한다 — 연결 표시가 이걸로 켜진다", async () => {
    const ok = await llmFetch("/v1/models");
    expect((await ok.json()).data[0].id).toBe("claude-haiku-5-5");
    script.hasKey = false;
    expect((await llmFetch("/v1/models")).status).toBe(503);
  });

  it("/props 는 64K 상한을 알려준다", async () => {
    expect((await (await llmFetch("/props")).json()).n_ctx).toBe(64_000);
  });
});

it("로컬 주소면 그냥 fetch 한다", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  await llmFetch("/v1/models", {}, "http://127.0.0.1:8803");
  expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8803/v1/models", {});
  vi.unstubAllGlobals();
});

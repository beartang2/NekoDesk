// @vitest-environment jsdom

import { it, expect, beforeEach, vi, describe } from "vitest";

/** Rust 쪽 claude_chat 을 흉내 낸다. 테스트마다 어떤 사건을 흘릴지 정한다. */
type Ev = { event: string; data?: unknown };
const script = vi.hoisted(() => ({ events: [] as Ev[], hasKey: true }));
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (ev: T) => void = () => {};
  }
  return { invoke, Channel };
});

import {
  CLAUDE_MIN_MAX_TOKENS,
  createUsageTap,
  decodeToolName,
  encodeToolName,
  explainClaudeError,
  llmFetch,
  toClaudeBody,
} from "./llm-transport";
import { useSettingsStore } from "../stores/settingsStore";
import { useClaudeBudget } from "../stores/claudeBudget";

beforeEach(() => {
  localStorage.clear();
  script.events = [];
  script.hasKey = true;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "secret_has") return script.hasKey;
    if (cmd === "claude_chat") {
      const ch = args.onEvent as { onmessage: (e: Ev) => void };
      // 실제 채널처럼 커맨드가 돌아온 뒤에 사건이 도착한다.
      queueMicrotask(() => script.events.forEach((e) => ch.onmessage(e)));
      return undefined;
    }
    return undefined;
  });
  useSettingsStore.getState().setLlmUrl("claude://claude-haiku-5-5");
  useClaudeBudget.getState().setSettings({ budgetUsd: 80, resetDay: 1 });
  useClaudeBudget.setState((s) => ({ usage: { ...s.usage, spentUsd: 0, requests: 0, inputTokens: 0, outputTokens: 0 } }));
});

describe("toClaudeBody", () => {
  it("llama 전용 필드와 temperature 를 빼고 모델을 넣는다", () => {
    const out = toClaudeBody(
      { messages: [], max_tokens: 20, temperature: 0.2, grammar: "root ::= x", chat_template_kwargs: {}, stream: true },
      "claude-haiku-5-5"
    );
    expect(out).toEqual({ messages: [], max_tokens: CLAUDE_MIN_MAX_TOKENS, stream: true, model: "claude-haiku-5-5" });
  });

  it("큰 max_tokens 는 그대로 둔다", () => {
    expect(toClaudeBody({ messages: [], max_tokens: 9000 }, "m").max_tokens).toBe(9000);
  });

  it("툴만 부른 assistant 턴의 빈 본문을 null 로 바꾼다 — 빈 텍스트 블록은 Claude 가 거부한다", () => {
    const call = { id: "1", type: "function", function: { name: "todo.list", arguments: "{}" } };
    const out = toClaudeBody({ messages: [
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "assistant", content: "안녕" },
    ] }, "m");
    expect(out.messages).toEqual([
      { role: "assistant", content: null, tool_calls: [{ ...call, function: { ...call.function, name: "todo__list" } }] },
      { role: "assistant", content: "안녕" },
    ]);
  });
});

describe("툴 이름 — Claude 는 ^[a-zA-Z0-9_-]{1,128}$ 만 받는다", () => {
  const NAME_RULE = /^[a-zA-Z0-9_-]{1,128}$/;

  it("tools 와 이력의 tool_calls 이름에서 점을 없애고, 응답 이름은 되돌린다", () => {
    const out = toClaudeBody({
      tools: [
        { type: "function", function: { name: "todo.list", description: "d", parameters: {} } },
        { type: "function", function: { name: "web.search", description: "d", parameters: {} } },
      ],
      messages: [
        { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "todo.list", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "1", content: "[]" },
      ],
    }, "m");
    const tools = out.tools as Array<{ function: { name: string } }>;
    for (const t of tools) expect(t.function.name).toMatch(NAME_RULE);
    expect(tools.map((t) => decodeToolName(t.function.name))).toEqual(["todo.list", "web.search"]);
    const msgs = out.messages as Array<{ tool_calls?: Array<{ function: { name: string } }> }>;
    expect(msgs[0].tool_calls![0].function.name).toBe(tools[0].function.name);
  });

  it("MCP 의 이상한 이름도 규칙에 맞추고 충돌을 피한다", () => {
    toClaudeBody({ tools: [
      { type: "function", function: { name: "검색/도구", parameters: {} } },
      { type: "function", function: { name: "a.b", parameters: {} } },
      { type: "function", function: { name: "a__b", parameters: {} } },
    ] }, "m");
    expect(encodeToolName("검색/도구")).toMatch(NAME_RULE);
    const ab = encodeToolName("a.b");
    const aub = encodeToolName("a__b");
    expect(ab).not.toBe(aub);
    expect(decodeToolName(ab)).toBe("a.b");
    expect(decodeToolName(aub)).toBe("a__b");
  });

  it("바꾼 적 없는 이름은 그대로 돌려준다", () => {
    expect(decodeToolName("plain_name")).toBe("plain_name");
  });
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

describe("createUsageTap", () => {
  it("스트림의 마지막 usage 를 쓴다", () => {
    const tap = createUsageTap(true);
    tap.push('data: {"choices":[{"delta":{"content":"하"}}],"usage":null}\n\ndata: {"choices":[],"us');
    tap.push('age":{"prompt_tokens":1200,"completion_tokens":80}}\n\ndata: [DONE]\n\n');
    expect(tap.end()).toEqual({ prompt: 1200, completion: 80 });
  });
  it("비스트림은 끝난 뒤 JSON 에서 읽는다", () => {
    const tap = createUsageTap(false);
    tap.push('{"choices":[],"usage":{"prompt_tokens":10,');
    tap.push('"completion_tokens":5}}');
    expect(tap.end()).toEqual({ prompt: 10, completion: 5 });
  });
});

describe("llmFetch (Claude 프로필)", () => {
  it("스트림을 Response 로 감싸 돌려주고 사용액을 장부에 적는다", async () => {
    script.events = [
      { event: "head", data: { status: 200 } },
      { event: "chunk", data: { text: 'data: {"choices":[{"delta":{"content":"야옹"}}]}\n\n' } },
      { event: "chunk", data: { text: 'data: {"choices":[],"usage":{"prompt_tokens":100000,"completion_tokens":1000}}\n\n' } },
      { event: "end" },
    ];
    const res = await llmFetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true, temperature: 0.3 }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("야옹");

    const sent = JSON.parse((invoke.mock.calls.find((c) => c[0] === "claude_chat")![1] as { body: string }).body);
    expect(sent.model).toBe("claude-haiku-5-5");
    expect(sent.temperature).toBeUndefined();

    // 100K 는 구간 안(초과가 아님) — 0.1/0.5 요율: 0.01 + 0.0005
    const u = useClaudeBudget.getState().usage;
    expect(u.requests).toBe(1);
    expect(u.spentUsd).toBeCloseTo(0.0105, 6);
  });

  it("오류 응답은 사람이 읽을 말로 바꿔 같은 상태코드로 돌려준다", async () => {
    script.events = [
      { event: "head", data: { status: 400 } },
      { event: "chunk", data: { text: '{"error":{"message":"Your credit balance is too low"}}' } },
      { event: "end" },
    ];
    const res = await llmFetch("/v1/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/크레딧이 바닥났어/);
  });

  it("응답 전에 실패하면(키 없음) 거절한다", async () => {
    script.events = [{ event: "error", data: { message: "Claude API 키가 없어." } }];
    await expect(llmFetch("/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(/키가 없어/);
  });

  it("예산을 다 썼으면 보내지도 않는다", async () => {
    useClaudeBudget.setState((s) => ({ usage: { ...s.usage, spentUsd: 80 } }));
    await expect(llmFetch("/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(/예산/);
    expect(invoke).not.toHaveBeenCalledWith("claude_chat", expect.anything());
  });

  it("멈추면 Rust 쪽 요청도 끊는다", async () => {
    script.events = [{ event: "head", data: { status: 200 } }];
    const ctl = new AbortController();
    const res = await llmFetch("/v1/chat/completions", { method: "POST", body: '{"stream":true}', signal: ctl.signal });
    const reading = res.text();
    ctl.abort();
    await expect(reading).rejects.toThrow();
    expect(invoke).toHaveBeenCalledWith("claude_cancel", expect.objectContaining({ id: expect.any(String) }));
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

// @vitest-environment jsdom

import { it, expect, beforeEach, vi, describe } from "vitest";

/** Rust 쪽 claude_proxy 를 흉내 낸다. 테스트마다 어떤 사건을 흘릴지 정한다. */
type Ev = { event: string; data?: unknown };
const script = vi.hoisted(() => ({ events: [] as Ev[], hasKey: true }));
const invoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => {
  class Channel<T> {
    onmessage: (ev: T) => void = () => {};
  }
  return { invoke, Channel };
});

import { claudeToolNames, explainClaudeError, isPlainHttp, llmFetch } from "./llm-transport";
import { useSettingsStore } from "../stores/settingsStore";
import { useClaudeBudget } from "../stores/claudeBudget";

beforeEach(() => {
  localStorage.clear();
  script.events = [];
  script.hasKey = true;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "secret_has") return script.hasKey;
    if (cmd === "claude_proxy") {
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

describe("claudeToolNames", () => {
  it("점이 든 툴 이름을 Claude 가 받는 이름으로 바꾼다 — 원래 있던 이름과 겹치지 않게", () => {
    const fn = (name: string) => ({ type: "function", function: { name, parameters: {} } });
    const map = claudeToolNames({ tools: [fn("todo.list"), fn("fs.read"), fn("fs_read")], messages: [] });
    expect(Object.fromEntries(map)).toEqual({ "todo.list": "todo_list", "fs.read": "fs_read_2" });
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

/** Messages API 의 SSE 한 사건. */
const sse = (data: Record<string, unknown>) => ({ event: "chunk", data: { text: `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n` } });
const start = (usage: Record<string, number> = { input_tokens: 10 }) => sse({ type: "message_start", message: { usage } });
const stop = (reason = "end_turn", output = 5) => [
  sse({ type: "message_delta", delta: { stop_reason: reason }, usage: { output_tokens: output } }),
  sse({ type: "message_stop" }),
];

describe("llmFetch (Claude 프로필)", () => {
  it("Messages 스트림을 OpenAI 모양으로 바꿔 돌려주고, 캐시를 반영해 사용액을 적는다", async () => {
    script.events = [
      { event: "head", data: { status: 200, headers: [["content-type", "text/event-stream"]] } },
      start({ input_tokens: 10_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 90_000 }),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "야옹" } }),
      sse({ type: "content_block_stop", index: 0 }),
      ...stop("end_turn", 1000),
      { event: "end" },
    ];
    const res = await llmFetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "system", content: "고양이" }, { role: "user", content: "hi" }], stream: true, temperature: 0.3 }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"content":"야옹"');
    expect(text).toContain('"prompt_tokens":100000');
    expect(text).toContain("data: [DONE]");

    const sent = JSON.parse((invoke.mock.calls.find((c) => c[0] === "claude_proxy")![1] as { body: string }).body);
    expect(sent.model).toBe("claude-haiku-5-5");
    expect(sent.temperature).toBeUndefined();
    expect(sent.system[0].text).toBe("고양이");
    expect(sent.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);

    // 0.1/0.5 요율: 입력 10K 0.001 + 캐시 읽기 90K × 0.1배 0.0009 + 출력 1K 0.0005
    const u = useClaudeBudget.getState().usage;
    expect(u.requests).toBe(1);
    expect(u.spentUsd).toBeCloseTo(0.0024, 6);
  });

  it("스트림을 원하지 않은 호출엔 끝난 응답을 OpenAI JSON 한 덩이로 준다", async () => {
    script.events = [
      { event: "head", data: { status: 200, headers: [["content-type", "text/event-stream"]] } },
      start(),
      sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "끝" } }),
      ...stop(),
      { event: "end" },
    ];
    const res = await llmFetch("/v1/chat/completions", { method: "POST", body: JSON.stringify({ messages: [] }) });
    const json = await res.json();
    expect(json.choices[0].message.content).toBe("끝");
    expect(json.choices[0].finish_reason).toBe("stop");
  });

  it("스트림 안에서 온 오류(과부하)는 읽는 쪽에 오류로 올린다", async () => {
    script.events = [
      { event: "head", data: { status: 200, headers: [["content-type", "text/event-stream"]] } },
      start(),
      sse({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }),
      { event: "end" },
    ];
    const res = await llmFetch("/v1/chat/completions", { method: "POST", body: '{"stream":true}' });
    await expect(res.text()).rejects.toThrow(/Overloaded/);
  });

  it("오류 응답은 사람이 읽을 말로 바꿔 같은 상태코드로 돌려준다", async () => {
    script.events = [
      { event: "head", data: { status: 400, headers: [["content-type", "application/json"]] } },
      { event: "chunk", data: { text: '{"error":{"message":"Your credit balance is too low"}}' } },
      { event: "end" },
    ];
    const res = await llmFetch("/v1/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/크레딧이 바닥났어/);
  });

  it("나가기 전에 툴 결과·사용자 글의 비밀을 가리고, Claude 가 돌려준 블록 원본은 건드리지 않는다", async () => {
    script.events = [{ event: "head", data: { status: 200, headers: [["content-type", "text/event-stream"]] } }, start(), ...stop("end_turn"), { event: "end" }];
    const raw = [{ type: "text", text: "키는 sk-ant-api03-abcdefghijklmnopqrstuvwxyz" }];
    await (await llmFetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        stream: true,
        messages: [
          { role: "user", content: [{ type: "text", text: "이거 봐 ghp_abcdefghijklmnopqrstuvwxyz0123456789" }] },
          { role: "assistant", content: "", anthropic_content: raw },
          { role: "tool", tool_call_id: "c1", content: "API_TOKEN=supersecretvalue" },
        ],
      }),
    })).text();
    const body = invoke.mock.calls.find(([cmd]) => cmd === "claude_proxy")![1].body as string;
    expect(body).not.toContain("ghp_abcdefghij");
    expect(body).not.toContain("supersecretvalue");
    expect(JSON.parse(body).messages[1].content).toEqual(raw);
  });

  it("툴 이름을 바꿔 보내고, 돌아온 호출은 원래 이름으로 받는다", async () => {
    script.events = [
      { event: "head", data: { status: 200, headers: [["content-type", "text/event-stream"]] } },
      start(),
      sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "todo_add", input: {} } }),
      sse({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"content":"우유"}' } }),
      sse({ type: "content_block_stop", index: 0 }),
      ...stop("tool_use"),
      { event: "end" },
    ];
    const res = await llmFetch("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ stream: true, messages: [], tools: [{ type: "function", function: { name: "todo.add", parameters: {} } }] }),
    });
    const text = await res.text();
    expect(text).toContain('"name":"todo.add"');
    expect(text).toContain('"finish_reason":"tool_calls"');
    const sent = JSON.parse(invoke.mock.calls.find(([cmd]) => cmd === "claude_proxy")![1].body);
    expect(sent.tools[0].name).toBe("todo_add");
  });

  it("키가 없으면 Rust 가 인증 오류로 답하고, 재시도 없이 그 안내를 돌려준다", async () => {
    script.events = [
      { event: "head", data: { status: 401, headers: [["content-type", "application/json"]] } },
      { event: "chunk", data: { text: '{"type":"error","error":{"type":"authentication_error","message":"Claude API 키가 없어."}}' } },
      { event: "end" },
    ];
    const res = await llmFetch("/v1/chat/completions", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/키가/);
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "claude_proxy")).toHaveLength(1);
  });

  it("SDK 가 보낸 요청은 가짜 키와 beta 헤더를 달고 Rust 로 간다", async () => {
    script.events = [{ event: "head", data: { status: 200, headers: [["content-type", "text/event-stream"]] } }, start(), ...stop(), { event: "end" }];
    await (await llmFetch("/v1/chat/completions", { method: "POST", body: '{"stream":true}' })).text();
    const args = invoke.mock.calls.find(([cmd]) => cmd === "claude_proxy")![1] as { path: string; headers: Record<string, string> };
    expect(args.path).toBe("/v1/messages");
    expect(args.headers["anthropic-beta"]).toContain("thinking-binding-controls-2026-08-01");
    // 키 자리엔 가짜가 들어간다. Rust 가 이 헤더를 버리고 키체인의 키를 붙인다.
    expect(args.headers.authorization).toBe("Bearer set-by-rust-proxy");
  });

  it("예산을 다 썼으면 보내지도 않는다", async () => {
    useClaudeBudget.setState((s) => ({ usage: { ...s.usage, spentUsd: 80 } }));
    await expect(llmFetch("/v1/chat/completions", { method: "POST", body: "{}" })).rejects.toThrow(/예산/);
    expect(invoke).not.toHaveBeenCalledWith("claude_proxy", expect.anything());
  });

  it("멈추면 Rust 쪽 요청도 끊는다", async () => {
    script.events = [{ event: "head", data: { status: 200, headers: [["content-type", "text/event-stream"]] } }];
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

  it("/props 는 모델 기본 창을, 설정에서 고르면 그 값을 알려준다 — 선택지에 없는 값은 무시한다", async () => {
    const nCtx = async (model: string) =>
      (await (await llmFetch("/props", {}, `claude://${model}`)).json()).n_ctx;
    expect(await nCtx("claude-haiku-5-5")).toBe(64_000);
    expect(await nCtx("claude-sonnet-5-5")).toBe(64_000);
    expect(await nCtx("claude-opus-5-5")).toBe(32_000);
    expect(await nCtx("claude-unknown")).toBe(32_000);
    useSettingsStore.getState().setClaudeContext("claude-opus-5-5", 128_000);
    expect(await nCtx("claude-opus-5-5")).toBe(128_000);
    // Haiku 는 10만 토큰을 넘으면 5배 요금이라 128K 를 열지 않는다.
    useSettingsStore.getState().setClaudeContext("claude-haiku-5-5", 128_000);
    expect(await nCtx("claude-haiku-5-5")).toBe(64_000);
  });
});

it("로컬 주소면 그냥 fetch 한다", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
  vi.stubGlobal("fetch", fetchMock);
  await llmFetch("/v1/models", {}, "http://127.0.0.1:8803");
  expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8803/v1/models", {});
  vi.unstubAllGlobals();
});

describe("평문 http 막기", () => {
  it("맥 안·Tailscale 은 http 여도 괜찮고, 같은 와이파이의 다른 기기는 막는다", () => {
    for (const ok of ["http://localhost:8803", "http://127.0.0.1:8080", "http://[::1]:8080", "http://100.101.2.3:8080",
      "http://box.tail1234.ts.net:8080", "https://192.168.0.10:8080", "claude://claude-haiku-5-5"]) {
      expect(isPlainHttp(ok), ok).toBe(false);
    }
    for (const bad of ["http://192.168.0.10:8080", "http://10.0.0.2", "http://my-server.local:8080", "http://100.20.1.1"]) {
      expect(isPlainHttp(bad), bad).toBe(true);
    }
  });

  it("평문 http 주소로는 요청을 내보내지 않는다", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(llmFetch("/v1/models", {}, "http://192.168.0.10:8080")).rejects.toThrow(/보내지 않았어/);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

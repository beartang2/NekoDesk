import { describe, it, expect } from "vitest";
import { MessagesTranslator, RawTurnCache, toMessagesRequest } from "./claude-messages";
import { decodeToolName } from "./tool-names";

const sse = (events: Array<Record<string, unknown>>) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");

/** 번역된 chat-completions SSE 를 청크 객체 배열로. */
function chunks(out: string): Array<Record<string, unknown>> {
  return out
    .split("\n\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trim())
    .filter((p) => p !== "[DONE]")
    .map((p) => JSON.parse(p) as Record<string, unknown>);
}
const deltas = (out: string) => chunks(out).map((c) => (c.choices as Array<{ delta: Record<string, unknown> }>)[0]?.delta).filter(Boolean);

describe("toMessagesRequest", () => {
  const base = { model: "claude-haiku-5-5", serverTools: [], rawCache: new RawTurnCache() };

  it("system 은 위로, 툴 결과 여러 개는 user 메시지 하나로, 끼어든 말은 그 뒤 text 블록으로", () => {
    const req = toMessagesRequest({
      max_tokens: 100,
      messages: [
        { role: "system", content: "너는 고양이야." },
        { role: "user", content: "할 일이랑 일정 보여줘" },
        { role: "assistant", content: "", tool_calls: [
          { id: "toolu_1", type: "function", function: { name: "todo.list", arguments: "{}" } },
          { id: "toolu_2", type: "function", function: { name: "schedule.list", arguments: '{"range":"today"}' } },
        ] },
        { role: "tool", tool_call_id: "toolu_1", content: "[todo.list 결과]\n- 우유" },
        { role: "tool", tool_call_id: "toolu_2", content: "[schedule.list 결과]\n(없음)" },
        { role: "user", content: "아 그리고 내일도" },
      ],
      tools: [{ type: "function", function: { name: "todo.list", description: "할 일", parameters: { type: "object", properties: {} } } }],
    }, base);

    expect(req.system).toBe("너는 고양이야.");
    const msgs = req.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    // assistant: 빈 텍스트는 빼고 tool_use 둘. 이름은 규칙에 맞게.
    expect(msgs[1].content.map((b) => b.type)).toEqual(["tool_use", "tool_use"]);
    expect(msgs[1].content[0].name).toBe("todo__list");
    expect(msgs[1].content[1].input).toEqual({ range: "today" });
    // 툴 결과 둘 + 끼어든 말이 한 user 메시지.
    expect(msgs[2].content.map((b) => b.type)).toEqual(["tool_result", "tool_result", "text"]);
    expect(msgs[2].content[0]).toMatchObject({ tool_use_id: "toolu_1" });
    expect(msgs[2].content[2]).toEqual({ type: "text", text: "아 그리고 내일도" });

    const tools = req.tools as Array<Record<string, unknown>>;
    expect(tools[0]).toEqual({ name: "todo__list", description: "할 일", input_schema: { type: "object", properties: {} } });
    expect(decodeToolName("todo__list")).toBe("todo.list");
    expect(req.tool_choice).toEqual({ type: "auto" });
    expect(req.cache_control).toEqual({ type: "ephemeral" });
    expect(req.stream).toBe(true);
    expect(req.max_tokens).toBe(4096); // 바닥
    expect(req.thinking).toEqual({ type: "adaptive" });
  });

  it("이미지 data URL 은 base64 블록으로", () => {
    const req = toMessagesRequest({
      messages: [{ role: "user", content: [
        { type: "text", text: "이거 뭐야" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ] }],
    }, base);
    const msgs = req.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(msgs[0].content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } });
  });

  it("effort·생각 끄기 힌트와 서버 툴", () => {
    const req = toMessagesRequest(
      { messages: [{ role: "user", content: "대체야 따로야" }], neko_effort: "low", neko_thinking_off: true },
      { ...base, serverTools: [{ type: "web_search_20250305", name: "web_search", max_uses: 8 }], timezone: "Asia/Seoul" }
    );
    expect(req.output_config).toEqual({ effort: "low" });
    expect(req.thinking).toEqual({ type: "disabled" });
    expect(req.tools).toEqual([{ type: "web_search_20250305", name: "web_search", max_uses: 8, user_location: { type: "approximate", timezone: "Asia/Seoul" } }]);
  });

  it("이력의 assistant 턴은 기억해 둔 원본 블록(thinking signature 포함)으로 바꿔 보낸다", () => {
    const cache = new RawTurnCache();
    const raw = [
      { type: "thinking", thinking: "", signature: "SIG" },
      { type: "tool_use", id: "toolu_9", name: "todo__list", input: {} },
    ];
    cache.remember(raw);
    const req = toMessagesRequest({
      messages: [
        { role: "user", content: "할 일" },
        { role: "assistant", content: "", tool_calls: [{ id: "toolu_9", type: "function", function: { name: "todo.list", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "toolu_9", content: "- 우유" },
      ],
    }, { ...base, rawCache: cache });
    const msgs = req.messages as Array<{ content: unknown[] }>;
    expect(msgs[1].content).toEqual(raw);
  });

  it("빈 user 메시지와 assistant 로 시작하는 이력도 API 가 받는 모양으로", () => {
    const req = toMessagesRequest({ messages: [{ role: "assistant", content: "안녕" }, { role: "user", content: "" }] }, base);
    const msgs = req.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(msgs[0]).toEqual({ role: "user", content: [{ type: "text", text: "(이어서)" }] });
    expect(msgs[2].content[0].text).toBe("(빈 메시지)");
  });
});

describe("MessagesTranslator", () => {
  it("생각·본문·툴 호출을 chat-completions 청크로, usage 는 캐시 포함 전체 입력으로", () => {
    const t = new MessagesTranslator();
    const out =
      t.feed(sse([
        { type: "message_start", message: { usage: { input_tokens: 100, cache_read_input_tokens: 7000, cache_creation_input_tokens: 500, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "SIG" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "할 일 볼" } },
        { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "게" } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "toolu_1", name: "todo__list", input: {} } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"do" } },
        { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "ne\":false}" } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 42 } },
        { type: "message_stop" },
      ])) + t.finish();

    const d = deltas(out);
    expect(d.filter((x) => x.content).map((x) => x.content).join("")).toBe("할 일 볼게");
    const calls = d.flatMap((x) => (x.tool_calls as Array<Record<string, unknown>> | undefined) ?? []);
    expect(calls[0]).toMatchObject({ index: 0, id: "toolu_1", function: { name: "todo__list", arguments: "" } });
    expect(calls.slice(1).map((c) => (c.function as { arguments: string }).arguments).join("")).toBe('{"done":false}');
    expect(chunks(out).some((c) => (c.choices as Array<{ finish_reason: string }>)[0]?.finish_reason === "tool_calls")).toBe(true);
    const usage = chunks(out).find((c) => c.usage)!.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(7600);
    expect(usage.completion_tokens).toBe(42);
    expect(usage.cache_read_input_tokens).toBe(7000);
    expect(out.trim().endsWith("data: [DONE]")).toBe(true);
    // 되돌려 보낼 원본: thinking(signature) + text + tool_use(input 파싱됨)
    expect(t.rawContent).toEqual([
      { type: "thinking", thinking: "", signature: "SIG" },
      { type: "text", text: "할 일 볼게" },
      { type: "tool_use", id: "toolu_1", name: "todo__list", input: { done: false } },
    ]);
    expect(t.stop).toBe("tool_use");
  });

  it("서버 웹 검색은 생각 칸에 표시하고, 인용 출처를 답 끝에 붙인다", () => {
    const t = new MessagesTranslator();
    const out =
      t.feed(sse([
        { type: "message_start", message: { usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: "content_block_start", index: 0, content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"query\":\"서울 날씨\"}" } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [
          { type: "web_search_result", title: "기상청", url: "https://kma.go.kr", encrypted_content: "ENC", page_age: null },
        ] } },
        { type: "content_block_stop", index: 1 },
        { type: "content_block_start", index: 2, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "맑아." } },
        { type: "content_block_delta", index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", url: "https://kma.go.kr", title: "기상청", cited_text: "맑음" } } },
        { type: "content_block_stop", index: 2 },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 9, server_tool_use: { web_search_requests: 1 } } },
        { type: "message_stop" },
      ])) + t.finish();

    const d = deltas(out);
    expect(d.find((x) => x.reasoning_content)?.reasoning_content).toBe("🔎 웹 검색: 서울 날씨\n");
    expect(d.filter((x) => x.content).map((x) => x.content).join("")).toBe("맑아.\n\n출처:\n- [기상청](https://kma.go.kr)");
    expect((chunks(out).find((c) => c.usage)!.usage as Record<string, number>).web_search_requests).toBe(1);
    // 서버 툴 블록은 원본 그대로 보관된다(encrypted_content 포함).
    expect(t.rawContent[1]).toMatchObject({ type: "web_search_tool_result", content: [{ encrypted_content: "ENC" }] });
  });

  it("거절은 사람이 읽을 한 줄로", () => {
    const t = new MessagesTranslator();
    const out = t.feed(sse([
      { type: "message_start", message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "message_delta", delta: { stop_reason: "refusal", stop_details: { category: "cyber" } }, usage: { output_tokens: 0 } },
      { type: "message_stop" },
    ])) + t.finish();
    expect(deltas(out).map((x) => x.content).join("")).toMatch(/안전 정책.*cyber/);
    expect(t.aggregate()).toMatchObject({ choices: [{ finish_reason: "stop" }] });
  });

  it("pause_turn 은 멈춤으로 알리고, 다음 메시지의 입력은 누적한다", () => {
    const t = new MessagesTranslator();
    t.feed(sse([
      { type: "message_start", message: { usage: { input_tokens: 100, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "찾는 중" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "pause_turn" }, usage: { output_tokens: 20 } },
      { type: "message_stop" },
    ]));
    expect(t.stop).toBe("pause_turn");
    expect(t.isMessageDone).toBe(true);
    const first = t.rawContent;
    t.beginNextMessage();
    const out = t.feed(sse([
      { type: "message_start", message: { usage: { input_tokens: 150, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " 다 됐어" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 30 } },
      { type: "message_stop" },
    ])) + t.finish();
    expect(first).toEqual([{ type: "text", text: "찾는 중" }]);
    expect(t.rawContent).toEqual([{ type: "text", text: " 다 됐어" }]);
    const usage = chunks(out).find((c) => c.usage)!.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(250);
    expect(usage.completion_tokens).toBe(30);
    expect(t.aggregate().choices).toMatchObject([{ message: { content: "찾는 중 다 됐어" } }]);
  });

  it("스트림 오류 이벤트는 던진다", () => {
    const t = new MessagesTranslator();
    expect(() => t.feed(sse([{ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }]))).toThrow(/overloaded/);
  });

  it("이벤트가 조각 경계에 걸쳐 와도 된다", () => {
    const t = new MessagesTranslator();
    const whole = sse([
      { type: "message_start", message: { usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "야옹" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]);
    let out = "";
    for (let i = 0; i < whole.length; i += 7) out += t.feed(whole.slice(i, i + 7));
    out += t.flush() + t.finish();
    expect(deltas(out).map((x) => x.content ?? "").join("")).toBe("야옹");
  });
});

import { describe, expect, it } from "vitest";
import { CLAUDE_MIN_MAX_TOKENS, createMessagesStreamAdapter, toMessagesRequest } from "./claude-messages";

const call = (id: string, name: string, args: string) => ({ id, type: "function", function: { name, arguments: args } });

describe("toMessagesRequest", () => {
  it("system 은 위로 올려 캐시 지점을 달고, 툴 정의는 Messages 모양으로 바꾼다", () => {
    const out = toMessagesRequest(
      {
        messages: [{ role: "system", content: "고양이야" }, { role: "user", content: "안녕" }],
        max_tokens: 20,
        temperature: 0.2,
        grammar: "root ::= x",
        tools: [{ type: "function", function: { name: "todo.list", description: "할 일", parameters: { type: "object" } } }],
      },
      "claude-haiku-5-5",
      new Map([["todo.list", "todo_list"]])
    );
    expect(out).toMatchObject({
      model: "claude-haiku-5-5",
      max_tokens: CLAUDE_MIN_MAX_TOKENS,
      stream: true,
      system: [{ type: "text", text: "고양이야", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "안녕" }] }],
      tools: [{ name: "todo_list", description: "할 일", input_schema: { type: "object" } }],
      tool_choice: { type: "auto" },
      cache_control: { type: "ephemeral" },
      thinking: { type: "adaptive", display: "summarized" },
    });
    expect(out).not.toHaveProperty("temperature");
    expect(out).not.toHaveProperty("grammar");
  });

  it("툴 호출은 tool_use 로, 결과와 그 뒤에 붙은 사용자 말은 한 user 메시지로 — tool_result 가 먼저", () => {
    const out = toMessagesRequest(
      {
        messages: [
          { role: "user", content: "보여줘" },
          { role: "assistant", content: "", tool_calls: [call("t1", "fs.read", '{"path":"a"}'), call("t2", "todo.list", "")] },
          { role: "tool", tool_call_id: "t1", content: "파일" },
          { role: "tool", tool_call_id: "t2", content: "할 일" },
          { role: "user", content: [{ type: "text", text: "이것도" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
        ],
      },
      "m",
      new Map([["fs.read", "fs_read"], ["todo.list", "todo_list"]])
    );
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "보여줘" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "t1", name: "fs_read", input: { path: "a" } },
          { type: "tool_use", id: "t2", name: "todo_list", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "파일" },
          { type: "tool_result", tool_use_id: "t2", content: "할 일" },
          { type: "text", text: "이것도" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
        ],
      },
    ]);
  });

  it("Claude 가 돌려준 블록 원본이 있으면 그 턴은 한 글자도 안 바꾸고 다시 보낸다", () => {
    const raw = [
      { type: "thinking", thinking: "요약", signature: "sig" },
      { type: "tool_use", id: "t1", name: "fs_read", input: { path: "a" } },
    ];
    const out = toMessagesRequest({
      messages: [
        { role: "user", content: "보여줘" },
        { role: "assistant", content: "", tool_calls: [call("t1", "fs.read", "{}")], anthropic_content: raw },
        { role: "tool", tool_call_id: "t1", content: "파일" },
      ],
    }, "m");
    expect((out.messages as { content: unknown }[])[1].content).toEqual(raw);
  });

  it("빈 assistant 글은 빼고 — 빈 텍스트 블록은 Claude 가 거부한다", () => {
    const out = toMessagesRequest({ messages: [{ role: "user", content: "a" }, { role: "assistant", content: "" }, { role: "user", content: "b" }] }, "m");
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }]);
  });
});

const ev = (data: Record<string, unknown>) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`;

describe("createMessagesStreamAdapter", () => {
  it("생각은 reasoning_content 로, 원본 블록(signature 포함)은 끝에 한 번 싣는다 — 조각이 끊겨 와도", () => {
    const a = createMessagesStreamAdapter(new Map([["fs_read", "fs.read"]]));
    const whole =
      ev({ type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 7 } } }) +
      ev({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }) +
      ev({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "파일을 봐야지" } }) +
      ev({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }) +
      ev({ type: "content_block_stop", index: 0 }) +
      ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "fs_read", input: {} } }) +
      ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } }) +
      ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"a"}' } }) +
      ev({ type: "content_block_stop", index: 1 }) +
      ev({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }) +
      ev({ type: "message_stop" });
    let out = "";
    for (let i = 0; i < whole.length; i += 37) out += a.push(whole.slice(i, i + 37));
    out += a.end();

    const chunks = out.split("\n\n").filter((l) => l.startsWith("data: {")).map((l) => JSON.parse(l.slice(6)));
    expect(chunks.map((c) => c.choices[0]?.delta?.reasoning_content).filter(Boolean)).toEqual(["파일을 봐야지"]);
    expect(chunks.flatMap((c) => c.choices[0]?.delta?.tool_calls ?? [])).toEqual([
      { index: 0, id: "t1", type: "function", function: { name: "fs.read", arguments: "" } },
      { index: 0, function: { arguments: '{"path":' } },
      { index: 0, function: { arguments: '"a"}' } },
    ]);
    const last = chunks[chunks.length - 1];
    expect(last.usage).toEqual({ prompt_tokens: 10, completion_tokens: 9, total_tokens: 19 });
    expect(last.anthropic_content).toEqual([
      { type: "thinking", thinking: "파일을 봐야지", signature: "sig" },
      { type: "tool_use", id: "t1", name: "fs_read", input: { path: "a" } },
    ]);
    expect(out.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(a.completion()).toMatchObject({
      choices: [{ message: { reasoning_content: "파일을 봐야지", tool_calls: [{ id: "t1", function: { name: "fs.read", arguments: '{"path":"a"}' } }] }, finish_reason: "tool_calls" }],
    });
  });

  it("거절로 끝나면 빈 답 대신 거절했다고 말한다", () => {
    const a = createMessagesStreamAdapter();
    const out = a.push(ev({ type: "message_start", message: { usage: {} } }) + ev({ type: "message_delta", delta: { stop_reason: "refusal" }, usage: { output_tokens: 0 } }));
    expect(out).toContain("답하지 않겠다고");
    expect(a.stopReason).toBe("refusal");
  });
});

import test from "node:test";
import assert from "node:assert/strict";
import { LLMClient } from "../backend/services/llm-client.js";

test("LLMClient uses configurable path, headers, and body", async () => {
  const originalFetch = global.fetch;
  let captured;

  global.fetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: "ok" } }]
        };
      }
    };
  };

  try {
    const client = new LLMClient({
      baseUrl: "http://127.0.0.1:8803",
      apiPath: "/custom/chat",
      model: "demo-model",
      timeoutMs: 1000,
      chatTemperature: 0.42,
      intentTemperature: 0.12,
      maxTokens: 256,
      headers: { Authorization: "Bearer demo" },
      requestBody: { top_p: 0.8 },
      chatSystemPrompt: "chat prompt",
      intentSystemPrompt: "intent prompt",
      fallbackReply: "fallback",
      connectionErrorReply: "error"
    });

    const reply = await client.chat([{ role: "user", content: "hello" }]);
    const body = JSON.parse(captured.init.body);

    assert.equal(reply, "ok");
    assert.equal(captured.url, "http://127.0.0.1:8803/custom/chat");
    assert.equal(captured.init.headers.Authorization, "Bearer demo");
    assert.equal(body.model, "demo-model");
    assert.equal(body.temperature, 0.42);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.max_tokens, 256);
    assert.equal(body.messages[0].content, "chat prompt");
  } finally {
    global.fetch = originalFetch;
  }
});

test("LLMClient includes view context in intent parsing payload", async () => {
  const originalFetch = global.fetch;
  let captured;

  global.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          choices: [{ message: { content: '{"type":"todo.list","confidence":0.9,"params":{}}' } }]
        };
      }
    };
  };

  try {
    const client = new LLMClient({
      baseUrl: "http://127.0.0.1:8803",
      apiPath: "/v1/chat/completions",
      model: "demo-model",
      timeoutMs: 1000,
      chatTemperature: 0.42,
      intentTemperature: 0.12,
      maxTokens: 256,
      headers: {},
      requestBody: {},
      chatSystemPrompt: "chat prompt",
      intentSystemPrompt: "intent prompt",
      fallbackReply: "fallback",
      connectionErrorReply: "error"
    });

    const result = await client.parseIntent("남은 할 일 보여줘", {
      activeView: "todo",
      currentDateTime: "2026-03-31T10:00:00.000Z",
      timezone: "Asia/Seoul"
    });

    assert.equal(result.type, "todo.list");
    assert.match(captured.messages[1].content, /activeView: todo/);
    assert.match(captured.messages[1].content, /timezone: Asia\/Seoul/);
  } finally {
    global.fetch = originalFetch;
  }
});

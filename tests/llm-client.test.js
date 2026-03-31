import test from "node:test";
import assert from "node:assert/strict";
import { LLMClient } from "../backend/services/llm-client.js";

function createClient(overrides = {}) {
  return new LLMClient({
    baseUrl: "http://127.0.0.1:8803",
    apiPath: "/v1/chat/completions",
    model: "demo-model",
    timeoutMs: 1000,
    chatTemperature: 0.42,
    intentTemperature: 0.12,
    intentMaxTokens: 64,
    toolPlanTemperature: 0.11,
    toolPlanMaxTokens: 96,
    maxTokens: 256,
    headers: {},
    requestBody: {},
    chatSystemPrompt: "chat prompt",
    intentSystemPrompt: "intent prompt",
    toolPlanSystemPrompt: "tool plan prompt",
    fallbackReply: "fallback",
    connectionErrorReply: "LLM 서버와 연결되지 않았어.",
    ...overrides
  });
}

test("LLMClient chat() posts FastAPI /chat body", async () => {
  const originalFetch = global.fetch;
  let captured;

  global.fetch = async (url, init) => {
    captured = { url, init };
    return {
      ok: true,
      async json() {
        return { content: "ok" };
      }
    };
  };

  try {
    const client = createClient();
    const reply = await client.chat([{ role: "user", content: "hello" }], undefined, {
      activeView: "chat",
      currentDateTime: "2026-03-31T12:34:56.000Z",
      timezone: "Asia/Seoul"
    });
    const body = JSON.parse(captured.init.body);

    assert.equal(reply, "ok");
    assert.equal(captured.url, "http://127.0.0.1:8000/chat");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers["Content-Type"], "application/json");
    assert.equal(body.system_prompt, "chat prompt");
    assert.equal(body.active_view, "chat");
    assert.equal(body.temperature, 0.42);
    assert.equal(body.max_tokens, 256);
    assert.equal(body.timeout_ms, 1000);
    assert.equal(body.current_datetime, "2026-03-31T12:34:56.000Z");
    assert.equal(body.timezone, "Asia/Seoul");
    assert.deepEqual(body.headers, {});
    assert.deepEqual(body.request_body, {});
    assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("LLMClient planToolUse() sends tool planner request and parses structured tool intent", async () => {
  const originalFetch = global.fetch;
  let captured;

  global.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          content: '{"useTool":true,"intent":{"type":"memo.list","confidence":0.9,"params":{}}}'
        };
      }
    };
  };

  try {
    const client = createClient();
    const result = await client.planToolUse(
      [
        { role: "user", content: "메모 뭐 있었지?" },
        { role: "assistant", content: "..." }
      ],
      {
        activeView: "chat",
        currentDateTime: "2026-03-31T10:00:00.000Z",
        timezone: "Asia/Seoul"
      }
    );

    assert.equal(result.type, "memo.list");
    assert.equal(captured.system_prompt, "tool plan prompt");
    assert.equal(captured.temperature, 0.11);
    assert.equal(captured.max_tokens, 96);
    assert.match(captured.messages[0].content, /activeView: chat/);
    assert.match(captured.messages[0].content, /conversation:/);
    assert.match(captured.messages[0].content, /user: 메모 뭐 있었지\?/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("LLMClient parseIntent() sends FastAPI body with intent prompt and view context", async () => {
  const originalFetch = global.fetch;
  let captured;

  global.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return {
          content: '{"type":"todo.list","confidence":0.9,"params":{}}'
        };
      }
    };
  };

  try {
    const client = createClient();
    const result = await client.parseIntent("남은 할 일 보여줘", {
      activeView: "todo",
      currentDateTime: "2026-03-31T10:00:00.000Z",
      timezone: "Asia/Seoul"
    });

    assert.equal(result.type, "todo.list");
    assert.equal(captured.system_prompt, "intent prompt");
    assert.equal(captured.active_view, "todo");
    assert.equal(captured.temperature, 0.12);
    assert.equal(captured.max_tokens, 64);
    assert.equal(captured.timeout_ms, 1000);
    assert.equal(captured.current_datetime, "2026-03-31T10:00:00.000Z");
    assert.equal(captured.timezone, "Asia/Seoul");
    assert.deepEqual(captured.headers, {});
    assert.deepEqual(captured.request_body, {});
    assert.match(captured.messages[0].content, /activeView: todo/);
    assert.match(captured.messages[0].content, /currentLocalDateTime: 2026-03-31T10:00:00.000Z/);
    assert.match(captured.messages[0].content, /timezone: Asia\/Seoul/);
    assert.match(captured.messages[0].content, /userInput: 남은 할 일 보여줘/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("LLMClient chat() forwards custom FastAPI request settings", async () => {
  const originalFetch = global.fetch;
  let captured;

  global.fetch = async (_url, init) => {
    captured = JSON.parse(init.body);
    return {
      ok: true,
      async json() {
        return { content: "ok" };
      }
    };
  };

  try {
    const client = createClient({
      headers: { Authorization: "Bearer test" },
      requestBody: { seed: 7 }
    });

    await client.chat([{ role: "user", content: "안녕" }], "custom prompt", {
      activeView: "chat",
      currentDateTime: "2026-03-31T09:00:00.000Z",
      timezone: "Asia/Seoul"
    });

    assert.deepEqual(captured.headers, { Authorization: "Bearer test" });
    assert.deepEqual(captured.request_body, { seed: 7 });
  } finally {
    global.fetch = originalFetch;
  }
});

test("LLMClient prefers FastAPI content response format", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    async json() {
      return { content: "fastapi reply" };
    }
  });

  try {
    const client = createClient();
    const reply = await client.chat([{ role: "user", content: "안녕" }]);
    assert.equal(reply, "fastapi reply");
  } finally {
    global.fetch = originalFetch;
  }
});

test("LLMClient falls back to legacy choices response parsing", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [{ message: { content: "legacy reply" } }]
      };
    }
  });

  try {
    const client = createClient();
    const reply = await client.chat([{ role: "user", content: "안녕" }]);
    assert.equal(reply, "legacy reply");
  } finally {
    global.fetch = originalFetch;
  }
});

test("LLMClient returns fallback reply when FastAPI response is empty", async () => {
  const originalFetch = global.fetch;

  global.fetch = async () => ({
    ok: true,
    async json() {
      return {};
    }
  });

  try {
    const client = createClient();
    const reply = await client.chat([{ role: "user", content: "안녕" }]);
    assert.equal(reply, "fallback");
  } finally {
    global.fetch = originalFetch;
  }
});

test("LLMClient returns a detailed timeout reply", async () => {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;

  global.fetch = async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    throw error;
  };
  console.error = () => {};

  try {
    const client = createClient({ timeoutMs: 12000 });
    const reply = await client.chat([{ role: "user", content: "안녕" }]);
    assert.equal(reply, "LLM 서버와 연결되지 않았어. (응답 시간이 12000ms를 넘어 중단됐어)");
  } finally {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

test("LLMClient returns a detailed HTTP error reply", async () => {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;

  global.fetch = async () => ({
    ok: false,
    status: 503
  });
  console.error = () => {};

  try {
    const client = createClient({ timeoutMs: 12000 });
    const reply = await client.chat([{ role: "user", content: "안녕" }]);
    assert.equal(reply, "LLM 서버와 연결되지 않았어. (서버가 HTTP 503를 반환했어)");
  } finally {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
  }
});

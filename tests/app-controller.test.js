import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createAppController } from "../backend/app-controller.js";
import { createDatabase } from "../backend/storage/database.js";
import { createRepositories } from "../backend/storage/repositories.js";

function makeRepositories() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "nekodesk-controller-")),
    "test.sqlite"
  );
  const db = createDatabase(dbPath);
  return createRepositories(db);
}

function extractToolResult(messages = []) {
  const internalMessage = messages.find(
    (message) =>
      typeof message.content === "string" &&
      message.content.startsWith("NekoDesk tool result JSON:\n")
  );

  if (!internalMessage) {
    return null;
  }

  return JSON.parse(internalMessage.content.replace("NekoDesk tool result JSON:\n", ""));
}

function makeController({
  parseIntent,
  chat,
  planToolUse,
  repositories = makeRepositories(),
  config: configOverride = {},
  webSearchClient
} = {}) {
  const llmClient = {
    async parseIntent(input, context) {
      if (parseIntent) {
        return parseIntent(input, context);
      }
      return { type: "chat", confidence: 0.5, params: { message: input } };
    },
    async chat(messages, systemPrompt, context) {
      if (chat) {
        return chat(messages, systemPrompt, context);
      }
      const toolResult = extractToolResult(messages);
      return toolResult
        ? `narrated:${toolResult.intentType}:${toolResult.status}`
        : "chat fallback";
    },
    async planToolUse(messages, context) {
      if (planToolUse) {
        return planToolUse(messages, context);
      }
      return null;
    }
  };

  return createAppController({
    repositories,
    llmClient,
    githubClient: {
      async getOverview() {
        return { status: "ok", summaryLines: ["GitHub ok"] };
      },
      async getContext() {
        return {
          status: "ok",
          summaryLines: ["GitHub ok"],
          contextLines: [
            "account",
            "@kdh: 12 public · 3 private",
            "",
            "attention",
            "Unread notifications: 2",
            "Review requests: 1"
          ]
        };
      }
    },
    webSearchClient: webSearchClient || {
      async search(query) {
        return {
          status: "ok",
          query,
          results: [
            {
              title: "Example result",
              url: "https://example.com",
              host: "example.com"
            }
          ]
        };
      }
    },
    config: {
      dbPath: ":memory:",
      conversationMemoryLimit: 40,
      llm: {
        baseUrl: "http://127.0.0.1:8803",
        historyLimit: 8,
        chatSystemPrompt: "chat prompt"
      },
      ...configOverride,
      llm: {
        baseUrl: "http://127.0.0.1:8803",
        historyLimit: 8,
        chatSystemPrompt: "chat prompt",
        ...(configOverride.llm || {})
      }
    }
  });
}

function queueParseIntent(intents) {
  const queue = [...intents];
  return async () => queue.shift() || { type: "chat", confidence: 0.5, params: {} };
}

test("requires confirmation before memo.deleteAll executes", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "memo.add", confidence: 0.95, params: { content: "첫 메모" } },
      { type: "memo.deleteAll", confidence: 0.96, params: {} }
    ])
  });

  await controller.handleInput("메모 저장", { activeView: "memo" });
  let viewModel = await controller.getViewModel({ activeView: "memo" });
  assert.equal(viewModel.panels.memo.lines.length, 1);

  const pending = await controller.handleInput("전체 메모 지워줘", { activeView: "memo" });
  assert.equal(pending.reply, "메모를 전부 지울까?");

  viewModel = await controller.getViewModel({ activeView: "memo" });
  assert.equal(viewModel.panels.memo.lines.length, 1);
  assert.equal(viewModel.pendingConfirmation?.message, "메모를 전부 지울까?");

  const confirmed = await controller.resolveConfirmation("confirm");
  assert.equal(confirmed.reply, "narrated:memo.deleteAll:success");

  viewModel = await controller.getViewModel({ activeView: "memo" });
  assert.deepEqual(viewModel.panels.memo.lines, ["(empty)"]);
});

test("can cancel memo.deleteAll confirmation", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "memo.add", confidence: 0.95, params: { content: "둘째 메모" } },
      { type: "memo.deleteAll", confidence: 0.96, params: {} }
    ])
  });

  await controller.handleInput("메모 저장", { activeView: "memo" });
  await controller.handleInput("전체 메모 지워줘", { activeView: "memo" });
  const cancelled = await controller.resolveConfirmation("cancel");

  assert.equal(cancelled.reply, "취소했어.");

  const viewModel = await controller.getViewModel({ activeView: "memo" });
  assert.equal(viewModel.panels.memo.lines.length, 1);
});

test("memo panel keeps the full memo text instead of truncating it", async () => {
  const longMemo = "admin system settings LLM BaseURL 회귀 점검과 MCP 라우터 연결 상태를 같이 확인하기";
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "memo.add", confidence: 0.95, params: { content: longMemo } }
    ])
  });

  await controller.handleInput("긴 메모 저장", { activeView: "memo" });
  const viewModel = await controller.getViewModel({ activeView: "memo" });

  assert.equal(viewModel.panels.memo.lines[0], `#1 ${longMemo}`);
});

test("requires confirmation before todo.deleteAll executes", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "todo.add", confidence: 0.95, params: { content: "README 정리" } },
      { type: "todo.deleteAll", confidence: 0.96, params: {} }
    ])
  });

  await controller.handleInput("할 일 추가", { activeView: "todo" });
  let viewModel = await controller.getViewModel({ activeView: "todo" });
  assert.equal(viewModel.panels.todo.lines.length, 1);

  const pending = await controller.handleInput("할 일 전부 지워줘", { activeView: "todo" });
  assert.equal(pending.reply, "할 일을 전부 지울까?");

  const confirmed = await controller.resolveConfirmation("confirm");
  assert.equal(confirmed.reply, "narrated:todo.deleteAll:success");

  viewModel = await controller.getViewModel({ activeView: "todo" });
  assert.deepEqual(viewModel.panels.todo.lines, ["(empty)"]);
});

test("requires confirmation before todo.deleteCompleted executes", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "todo.add", confidence: 0.95, params: { content: "README 정리" } },
      { type: "todo.complete", confidence: 0.95, params: { target: "1" } },
      { type: "todo.deleteCompleted", confidence: 0.96, params: {} }
    ])
  });

  await controller.handleInput("할 일 추가", { activeView: "todo" });
  await controller.handleInput("할 일 완료", { activeView: "todo" });

  const pending = await controller.handleInput("체크된 항목 지워줘", { activeView: "todo" });
  assert.equal(pending.reply, "완료된 할 일을 전부 지울까?");

  const confirmed = await controller.resolveConfirmation("confirm");
  assert.equal(confirmed.reply, "narrated:todo.deleteCompleted:success");

  const viewModel = await controller.getViewModel({ activeView: "todo" });
  assert.deepEqual(viewModel.panels.todo.lines, ["(empty)"]);
});

test("todo panel keeps the full todo text instead of truncating it", async () => {
  const longTodo = "/api/admin/mcp/ 라우터와 admin system settings LLM BaseURL 회귀 체크를 묶어서 확인하기";
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "todo.add", confidence: 0.95, params: { content: longTodo } }
    ])
  });

  await controller.handleInput("긴 할 일 추가", { activeView: "todo" });
  const viewModel = await controller.getViewModel({ activeView: "todo" });

  assert.equal(viewModel.panels.todo.lines[0], `[ ] 1. ${longTodo}`);
});

test("requires confirmation before schedule.deleteAll executes", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      {
        type: "schedule.add",
        confidence: 0.95,
        params: {
          title: "회의",
          startAt: "2026-03-31T06:00:00.000Z",
          endAt: "2026-03-31T07:00:00.000Z",
          allDay: false
        }
      },
      { type: "schedule.deleteAll", confidence: 0.96, params: {} }
    ])
  });

  await controller.handleInput("일정 추가", { activeView: "schedule" });
  let viewModel = await controller.getViewModel({ activeView: "schedule" });
  assert.equal(viewModel.panels.schedule.lines.length, 1);

  const pending = await controller.handleInput("일정 전부 지워줘", { activeView: "schedule" });
  assert.equal(pending.reply, "일정을 전부 지울까?");

  const confirmed = await controller.resolveConfirmation("confirm");
  assert.equal(confirmed.reply, "narrated:schedule.deleteAll:success");

  viewModel = await controller.getViewModel({ activeView: "schedule" });
  assert.deepEqual(viewModel.panels.schedule.lines, ["(empty)"]);
});

test("schedule.delete can resolve a time-based target like 3시", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      {
        type: "schedule.add",
        confidence: 0.95,
        params: {
          title: "회의",
          startAt: "2026-03-30T18:00:00.000Z",
          endAt: "2026-03-30T19:00:00.000Z",
          allDay: false
        }
      },
      {
        type: "schedule.delete",
        confidence: 0.96,
        params: { target: "3시" }
      }
    ])
  });

  await controller.handleInput("일정 추가", { activeView: "schedule" });
  const deleted = await controller.handleInput("3시 일정 삭제해줘", { activeView: "schedule" });

  assert.equal(deleted.reply, "narrated:schedule.delete:success");

  const viewModel = await controller.getViewModel({ activeView: "schedule" });
  assert.deepEqual(viewModel.panels.schedule.lines, ["(empty)"]);
});

test("invalid structured intent falls back to chat", async () => {
  const controller = await makeController({
    parseIntent() {
      return { type: "memo.delete", confidence: 0.98, params: {} };
    },
    chat() {
      return "chat fallback";
    }
  });

  const result = await controller.handleInput("메모 지워줘", { activeView: "memo" });
  assert.equal(result.reply, "chat fallback");
  assert.equal(result.intent.type, "chat");
});

test("github.query answers with llm and appends notes to github panel", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      {
        type: "github.query",
        confidence: 0.96,
        params: { question: "지금 뭘 먼저 봐야 해?" }
      }
    ]),
    chat(messages) {
      assert.match(messages[0].content, /GitHub context:/);
      assert.match(messages[0].content, /Unread notifications: 2/);
      assert.match(messages[0].content, /Question: 지금 뭘 먼저 봐야 해\?/);
      return "리뷰 요청 1건과 알림 2건부터 보면 돼.";
    }
  });

  const result = await controller.handleInput("지금 뭘 먼저 봐야 해?", { activeView: "github" });
  assert.equal(result.reply, "리뷰 요청 1건과 알림 2건부터 보면 돼.");

  const viewModel = await controller.getViewModel({ activeView: "github" });
  assert.ok(viewModel.panels.github.lines.includes("notes"));
  assert.ok(viewModel.panels.github.lines.some((line) => line.includes("q1 · 지금 뭘 먼저 봐야 해?")));
  assert.ok(viewModel.panels.github.lines.some((line) => line.includes("a  · 리뷰 요청 1건과 알림 2건부터 보면 돼.")));
});

test("chat path can use memo.list as an internal tool and answer naturally", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "memo.add", confidence: 0.95, params: { content: "README 정리" } },
      { type: "chat", confidence: 0.5, params: { message: "메모 뭐 있었지?" } }
    ]),
    planToolUse: async () => ({ type: "memo.list", confidence: 0.92, params: {} }),
    chat(messages, systemPrompt) {
      const toolResult = extractToolResult(messages);
      if (!toolResult) {
        return "chat fallback";
      }

      assert.match(systemPrompt, /tool result json/i);

      if (toolResult.intentType === "memo.add") {
        return "narrated:memo.add:success";
      }

      assert.equal(toolResult.intentType, "memo.list");
      assert.equal(toolResult.status, "success");
      assert.deepEqual(toolResult.data.items, [{ id: 1, content: "README 정리" }]);
      return "narrated:memo.list:success";
    }
  });

  await controller.handleInput("메모 저장", { activeView: "memo" });
  const result = await controller.handleInput("메모 뭐 있었지?", { activeView: "chat" });

  assert.equal(result.reply, "narrated:memo.list:success");
});

test("chat path can turn a planned destructive tool into confirmation", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "memo.add", confidence: 0.95, params: { content: "첫 메모" } },
      { type: "chat", confidence: 0.5, params: { message: "메모 전부 없애줘" } }
    ]),
    planToolUse: async () => ({ type: "memo.deleteAll", confidence: 0.93, params: {} })
  });

  await controller.handleInput("메모 저장", { activeView: "memo" });
  const result = await controller.handleInput("메모 전부 없애줘", { activeView: "chat" });

  assert.equal(result.reply, "메모를 전부 지울까?");
  const viewModel = await controller.getViewModel({ activeView: "chat" });
  assert.equal(viewModel.pendingConfirmation?.message, "메모를 전부 지울까?");
});

test("view.switch intent can move to another tab by language", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "view.switch", confidence: 0.94, params: { view: "github" } }
    ]),
    chat(messages) {
      const toolResult = extractToolResult(messages);
      assert.equal(toolResult.intentType, "view.switch");
      assert.equal(toolResult.status, "success");
      assert.equal(toolResult.data.view, "github");
      return "narrated:view.switch:success";
    }
  });

  const result = await controller.handleInput("깃허브 화면으로 가줘", { activeView: "chat" });

  assert.equal(result.reply, "narrated:view.switch:success");
  assert.equal(result.nextView, "github");
});

test("view.switch falls back to deterministic success text when narration fails", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "view.switch", confidence: 0.94, params: { view: "memo" } }
    ]),
    chat() {
      return "chat fallback";
    },
    config: {
      llm: {
        fallbackReply: "chat fallback"
      }
    }
  });

  const result = await controller.handleInput("메모 화면으로 가줘", { activeView: "chat" });

  assert.equal(result.reply, "memo 화면으로 바꿨어.");
  assert.equal(result.nextView, "memo");
});

test("web.search uses the web search client and narrates results", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "web.search", confidence: 0.95, params: { query: "openai news" } }
    ]),
    webSearchClient: {
      async search(query) {
        assert.equal(query, "오픈AI 관련 최신 소식 검색해줘");
        return {
          status: "ok",
          query,
          results: [
            {
              title: "OpenAI updates",
              url: "https://example.com/openai",
              host: "example.com"
            }
          ]
        };
      }
    },
    chat(messages, systemPrompt) {
      assert.match(systemPrompt, /tool result json/i);
      assert.match(systemPrompt, /only claim things that are directly supported/i);
      assert.match(systemPrompt, /include brief source attribution/i);
      const toolResult = extractToolResult(messages);
      assert.equal(toolResult.intentType, "web.search");
      assert.equal(toolResult.status, "ok");
      assert.equal(toolResult.data.query, "오픈AI 관련 최신 소식 검색해줘");
      assert.equal(toolResult.data.results[0].url, "https://example.com/openai");
      return "narrated:web.search:ok";
    }
  });

  const result = await controller.handleInput("오픈AI 관련 최신 소식 검색해줘", { activeView: "chat" });
  assert.equal(
    result.reply,
    "narrated:web.search:ok\n출처: OpenAI updates (example.com)"
  );
});

test("web.search falls back to deterministic result headlines when narration fails", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "web.search", confidence: 0.95, params: { query: "apple news" } }
    ]),
    webSearchClient: {
      async search(query) {
        return {
          status: "ok",
          query,
          results: [
            {
              title: "Apple posts quarterly results",
              url: "https://example.com/apple-q",
              host: "example.com"
            },
            {
              title: "Apple unveils new device",
              url: "https://example.org/apple-device",
              host: "example.org"
            }
          ]
        };
      }
    },
    chat() {
      return "chat fallback";
    },
    config: {
      llm: {
        fallbackReply: "chat fallback"
      }
    }
  });

  const result = await controller.handleInput("애플의 최신 뉴스 알려줘", { activeView: "chat" });
  assert.equal(
    result.reply,
    "DuckDuckGo로 \"애플의 최신 뉴스 알려줘\"를 검색했어. 눈에 띈 결과는 Apple posts quarterly results / Apple unveils new device 이야.\n출처: Apple posts quarterly results (example.com) | Apple unveils new device (example.org)"
  );
});

test("conversation history is restored from the database for a new controller", async () => {
  const repositories = makeRepositories();
  const controller = await makeController({
    repositories,
    parseIntent: queueParseIntent([
      { type: "chat", confidence: 0.5, params: { message: "안녕" } }
    ]),
    chat() {
      return "반가워.";
    }
  });

  await controller.handleInput("안녕", { activeView: "chat" });

  const restarted = await makeController({
    repositories,
    parseIntent: queueParseIntent([])
  });
  const viewModel = await restarted.getViewModel({ activeView: "chat" });

  assert.deepEqual(viewModel.conversation, [
    { role: "user", text: "안녕" },
    { role: "assistant", text: "반가워." }
  ]);
  assert.equal(viewModel.lastReply, "반가워.");
});

test("chat replies can carry hidden pet state metadata decided by the llm", async () => {
  const controller = await makeController({
    parseIntent: queueParseIntent([
      { type: "chat", confidence: 0.9, params: { message: "같이 놀자" } }
    ]),
    chat() {
      return "좋아, 실 한 뭉치부터 굴려볼까? [[PET_STATE:playful]]";
    }
  });

  const result = await controller.handleInput("같이 놀자", { activeView: "chat" });
  assert.equal(result.reply, "좋아, 실 한 뭉치부터 굴려볼까?");
  assert.equal(result.petMood, "playful");

  const viewModel = await controller.getViewModel({ activeView: "chat" });
  assert.equal(viewModel.petMood, "playful");
  assert.equal(viewModel.lastReply, "좋아, 실 한 뭉치부터 굴려볼까?");
});

test("conversation memory keeps only the most recent configured messages", async () => {
  const repositories = makeRepositories();
  const controller = await makeController({
    repositories,
    config: { conversationMemoryLimit: 3 },
    parseIntent: queueParseIntent([
      { type: "chat", confidence: 0.5, params: { message: "첫째" } },
      { type: "chat", confidence: 0.5, params: { message: "둘째" } },
      { type: "chat", confidence: 0.5, params: { message: "셋째" } }
    ]),
    chat(messages) {
      return `echo:${messages.at(-1).content}`;
    }
  });

  await controller.handleInput("첫째", { activeView: "chat" });
  await controller.handleInput("둘째", { activeView: "chat" });
  await controller.handleInput("셋째", { activeView: "chat" });

  const viewModel = await controller.getViewModel({ activeView: "chat" });

  assert.deepEqual(viewModel.conversation, [
    { role: "assistant", text: "echo:둘째" },
    { role: "user", text: "셋째" },
    { role: "assistant", text: "echo:셋째" }
  ]);

  const persistedMessages = repositories.conversation.listRecent(10);
  assert.equal(persistedMessages.length, 6);
});

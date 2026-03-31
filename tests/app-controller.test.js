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

function makeController({ parseIntent, chat, planToolUse } = {}) {
  const repositories = makeRepositories();
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
      return "chat fallback";
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
    config: {
      dbPath: ":memory:",
      llm: {
        baseUrl: "http://127.0.0.1:8803",
        historyLimit: 8,
        chatSystemPrompt: "chat prompt",
        narrateActionReplies: false
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
  assert.equal(confirmed.reply, "메모 1개를 전부 지웠어.");

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
  assert.equal(confirmed.reply, "할 일 1개를 전부 지웠어.");

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
  assert.equal(confirmed.reply, "완료된 할 일 1개를 지웠어.");

  const viewModel = await controller.getViewModel({ activeView: "todo" });
  assert.deepEqual(viewModel.panels.todo.lines, ["(empty)"]);
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
  assert.equal(confirmed.reply, "일정 1개를 전부 지웠어.");

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

  assert.equal(deleted.reply, "일정 #1 삭제 완료: 회의");

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
      assert.match(systemPrompt, /internal context/i);
      assert.ok(messages.some((message) => /NekoDesk internal context:/.test(message.content)));
      assert.ok(messages.some((message) => /#1 README 정리/.test(message.content)));
      return "전에 적어둔 메모는 README 정리였어.";
    }
  });

  await controller.handleInput("메모 저장", { activeView: "memo" });
  const result = await controller.handleInput("메모 뭐 있었지?", { activeView: "chat" });

  assert.equal(result.reply, "전에 적어둔 메모는 README 정리였어.");
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
    ])
  });

  const result = await controller.handleInput("깃허브 화면으로 가줘", { activeView: "chat" });

  assert.equal(result.reply, "github 화면으로 바꿨어.");
  assert.equal(result.nextView, "github");
});

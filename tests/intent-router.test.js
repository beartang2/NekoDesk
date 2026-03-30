import test from "node:test";
import assert from "node:assert/strict";
import { routeIntent } from "../backend/services/intent-router.js";

test("passes active view context into llm parsing", async () => {
  let captured;
  const llmClient = {
    async parseIntent(input, context) {
      captured = { input, context };
      return { type: "memo.add", confidence: 0.91, params: { content: "README 정리" } };
    }
  };

  const result = await routeIntent("이거 저장해줘", llmClient, { activeView: "memo" });

  assert.equal(result.type, "memo.add");
  assert.equal(captured.input, "이거 저장해줘");
  assert.equal(captured.context.activeView, "memo");
});

test("keeps explicit help as system command", async () => {
  const result = await routeIntent("help", { async parseIntent() { return null; } });
  assert.equal(result.type, "help");
});

test("falls back to chat when llm returns null", async () => {
  const result = await routeIntent("그냥 이야기하자", { async parseIntent() { return null; } });
  assert.equal(result.type, "chat");
  assert.equal(result.confidence, 0.5);
});

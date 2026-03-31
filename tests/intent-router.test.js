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

test("handles explicit help locally without llm parsing", async () => {
  let called = false;
  const result = await routeIntent("/help", {
    async parseIntent() {
      called = true;
      return { type: "chat", confidence: 0.5, params: {} };
    }
  });

  assert.equal(called, false);
  assert.equal(result.type, "help");
});

test("handles explicit exit locally without llm parsing", async () => {
  let called = false;
  const result = await routeIntent("/exit", {
    async parseIntent() {
      called = true;
      return { type: "chat", confidence: 0.5, params: {} };
    }
  });

  assert.equal(called, false);
  assert.equal(result.type, "system.exit");
});

test("falls back to chat when llm returns null", async () => {
  const result = await routeIntent("그냥 이야기하자", { async parseIntent() { return null; } });
  assert.equal(result.type, "chat");
  assert.equal(result.confidence, 0.5);
});

test("downgrades unsafe llm system.exit to chat", async () => {
  const result = await routeIntent("메모 지워줘", {
    async parseIntent() {
      return { type: "system.exit", confidence: 0.92, params: {} };
    }
  });

  assert.equal(result.type, "chat");
  assert.equal(result.confidence, 0.4);
});

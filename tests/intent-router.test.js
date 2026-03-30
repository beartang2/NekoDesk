import test from "node:test";
import assert from "node:assert/strict";
import { routeIntent } from "../backend/services/intent-router.js";

const llmClient = {
  async parseIntent() {
    return null;
  }
};

test("routes todo add", async () => {
  const result = await routeIntent("할 일 README 정리 추가", llmClient);
  assert.equal(result.type, "todo.add");
  assert.equal(result.params.content, "README 정리");
});

test("routes schedule add for tomorrow", async () => {
  const result = await routeIntent("내일 3시 회의 등록", llmClient);
  assert.equal(result.type, "schedule.add");
  assert.equal(result.params.title, "회의");
  assert.equal(typeof result.params.startAt, "string");
});

test("falls back to github overview", async () => {
  const result = await routeIntent("내 GitHub 상태 요약해줘", llmClient);
  assert.equal(result.type, "github.overview");
});

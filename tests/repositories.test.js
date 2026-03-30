import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../backend/storage/database.js";
import { createRepositories } from "../backend/storage/repositories.js";

function makeRepos() {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "nekodesk-test-")),
    "test.sqlite"
  );
  const db = createDatabase(dbPath);
  return createRepositories(db);
}

test("memo CRUD basics", () => {
  const repos = makeRepos();
  repos.memos.add({ content: "첫 메모" });
  const memos = repos.memos.listRecent();
  assert.equal(memos.length, 1);
  assert.equal(memos[0].content, "첫 메모");
});

test("todo complete by id", () => {
  const repos = makeRepos();
  const todo = repos.todos.add({ content: "테스트" });
  const completed = repos.todos.complete(String(todo.id));
  assert.equal(completed?.status, "done");
});

test("event listing by day", () => {
  const repos = makeRepos();
  repos.events.add({
    title: "회의",
    startAt: "2026-03-31T06:00:00.000Z",
    endAt: "2026-03-31T07:00:00.000Z",
    allDay: false
  });
  const events = repos.events.listForDay("2026-03-31T00:00:00.000Z", "2026-04-01T00:00:00.000Z");
  assert.equal(events.length, 1);
  assert.equal(events[0].title, "회의");
});

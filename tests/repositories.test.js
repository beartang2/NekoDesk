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

test("memo delete by id or fuzzy content", () => {
  const repos = makeRepos();
  const first = repos.memos.add({ content: "README 정리" });
  repos.memos.add({ content: "회의 메모" });

  const deletedById = repos.memos.delete(String(first.id));
  const deletedByText = repos.memos.delete("회의");
  const memos = repos.memos.listRecent();

  assert.equal(deletedById?.content, "README 정리");
  assert.equal(deletedByText?.content, "회의 메모");
  assert.equal(memos.length, 0);
});

test("memo deleteAll removes every memo", () => {
  const repos = makeRepos();
  repos.memos.add({ content: "첫 메모" });
  repos.memos.add({ content: "둘째 메모" });

  const result = repos.memos.deleteAll();
  const memos = repos.memos.listRecent();

  assert.equal(result.deletedCount, 2);
  assert.equal(memos.length, 0);
});

test("todo complete by id", () => {
  const repos = makeRepos();
  const todo = repos.todos.add({ content: "테스트" });
  const completed = repos.todos.complete(String(todo.id));
  assert.equal(completed?.status, "done");
});

test("todo delete by id or fuzzy content", () => {
  const repos = makeRepos();
  const first = repos.todos.add({ content: "README 정리" });
  repos.todos.add({ content: "회의 준비" });

  const deletedById = repos.todos.delete(String(first.id));
  const deletedByText = repos.todos.delete("회의");
  const todos = repos.todos.list();

  assert.equal(deletedById?.content, "README 정리");
  assert.equal(deletedByText?.content, "회의 준비");
  assert.equal(todos.length, 0);
});

test("todo deleteAll removes every todo", () => {
  const repos = makeRepos();
  repos.todos.add({ content: "첫 할 일" });
  repos.todos.add({ content: "둘째 할 일" });

  const result = repos.todos.deleteAll();
  const todos = repos.todos.list();

  assert.equal(result.deletedCount, 2);
  assert.equal(todos.length, 0);
});

test("todo deleteCompleted removes only done todos", () => {
  const repos = makeRepos();
  const doneTodo = repos.todos.add({ content: "완료할 일" });
  repos.todos.add({ content: "남길 할 일" });
  repos.todos.complete(String(doneTodo.id));

  const result = repos.todos.deleteCompleted();
  const todos = repos.todos.list();

  assert.equal(result.deletedCount, 1);
  assert.equal(todos.length, 1);
  assert.equal(todos[0].content, "남길 할 일");
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

test("event delete by id or fuzzy title", () => {
  const repos = makeRepos();
  const first = repos.events.add({
    title: "디자인 회의",
    startAt: "2026-03-31T06:00:00.000Z",
    endAt: "2026-03-31T07:00:00.000Z",
    allDay: false
  });
  repos.events.add({
    title: "주간 리뷰",
    startAt: "2026-03-31T08:00:00.000Z",
    endAt: "2026-03-31T09:00:00.000Z",
    allDay: false
  });

  const deletedById = repos.events.delete(String(first.id));
  const deletedByText = repos.events.delete("주간");
  const events = repos.events.listUpcoming();

  assert.equal(deletedById?.title, "디자인 회의");
  assert.equal(deletedByText?.title, "주간 리뷰");
  assert.equal(events.length, 0);
});

test("event deleteAll removes every event", () => {
  const repos = makeRepos();
  repos.events.add({
    title: "첫 일정",
    startAt: "2026-03-31T06:00:00.000Z",
    endAt: "2026-03-31T07:00:00.000Z",
    allDay: false
  });
  repos.events.add({
    title: "둘째 일정",
    startAt: "2026-03-31T08:00:00.000Z",
    endAt: "2026-03-31T09:00:00.000Z",
    allDay: false
  });

  const result = repos.events.deleteAll();
  const events = repos.events.listUpcoming();

  assert.equal(result.deletedCount, 2);
  assert.equal(events.length, 0);
});

test("conversation messages persist in chronological order", () => {
  const repos = makeRepos();
  repos.conversation.add({ role: "user", content: "안녕" });
  repos.conversation.add({ role: "assistant", content: "안녕, 반가워." });
  repos.conversation.add({ role: "system", content: "[confirm]" });

  const messages = repos.conversation.listRecent(10);

  assert.deepEqual(
    messages.map((message) => [message.role, message.content]),
    [
      ["user", "안녕"],
      ["assistant", "안녕, 반가워."],
      ["system", "[confirm]"]
    ]
  );
});

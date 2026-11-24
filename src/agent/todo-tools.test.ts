// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(async () => [{ id: 7, content: "우유", status: "open", priority: null, due_at: "2026-12-01", created_at: "", completed_at: null }]),
  update: vi.fn(async () => true),
  delete: vi.fn(async () => 0),
  reopen: vi.fn(async () => false),
}));
vi.mock("../api/tauri", async (orig) => ({ ...(await orig<typeof import("../api/tauri")>()), todosApi: api }));

import { getTool } from "./tool-registry";

describe("할 일 고치기·지우기·되돌리기 도구", () => {
  it("목록에 id 가 보여야 고칠 수 있다", async () => {
    const t = getTool("todo.list");
    // 이름이 앞, id 는 줄 끝 따로 떨어진 칸(사용자: 답에 "(id 33, 1014)" 가 나왔다)
    expect(t.summarize(await t.execute({}))).toBe("- 우유 [open] (마감: 2026-12-01) | id=7");
    expect(t.description).toContain("사용자에게 말하지 않는다");
  });

  it("todo.edit 는 준 것만 넘기고 clear_due 로 마감을 지운다", async () => {
    await getTool("todo.edit").execute({ id: 7, content: "두유" });
    expect(api.update).toHaveBeenLastCalledWith(7, { content: "두유", dueAt: undefined, clearDue: false });
    await getTool("todo.edit").execute({ id: 7, clear_due: true });
    expect(api.update).toHaveBeenLastCalledWith(7, { content: undefined, dueAt: undefined, clearDue: true });
    expect(getTool("todo.edit").summarize(false)).toContain("실패");
  });

  it("없는 id 는 실패로 알린다(schedule.delete 와 같게)", async () => {
    expect(getTool("todo.delete").summarize(await getTool("todo.delete").execute({ ids: [99] }))).toContain("삭제 실패");
    expect(getTool("todo.delete").summarize(2)).toBe("할 일 2개 삭제됨");
    expect(getTool("todo.reopen").summarize(await getTool("todo.reopen").execute({ id: 99 }))).toContain("실패");
  });
});

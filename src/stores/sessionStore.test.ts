// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const prune = vi.fn(async (_days: number, _keep: string[]) => ["old"]);
const db = { rows: [] as { id: string; title: string; created_at: number; summary: string | null }[], deleted: [] as string[], put: [] as string[] };
vi.mock("../api/tauri", () => ({
  conversationApi: { prune: (d: number, k: string[]) => prune(d, k) },
  sessionApi: {
    list: async () => db.rows,
    import: async (rows: typeof db.rows) => { db.rows = rows; },
    put: async (id: string) => { db.put.push(id); },
    delete: async (id: string) => { db.deleted.push(id); },
    compact: async () => {},
  },
}));

import { hydrateSessions, pruneOldSessions, useSessionStore } from "./sessionStore";

const DAY = 86_400_000;

beforeEach(() => {
  localStorage.clear();
  prune.mockClear();
  db.rows = []; db.deleted = []; db.put = [];
  useSessionStore.setState({
    sessions: [{ id: "open", title: "a", date: "" }, { id: "old", title: "b", date: "" }],
    activeId: "open",
  });
});

describe("오래된 대화 지우기", () => {
  it("끄면 아무것도 안 한다", async () => {
    expect(await pruneOldSessions(0)).toEqual([]);
    expect(prune).not.toHaveBeenCalled();
  });

  it("처음 켠 날부터 그 기간 동안은 지우지 않고, 지난 뒤엔 열린 세션만 빼고 지운다", async () => {
    const t0 = 1_700_000_000_000;
    expect(await pruneOldSessions(30, t0)).toEqual([]);
    expect(await pruneOldSessions(30, t0 + 29 * DAY)).toEqual([]);
    expect(prune).not.toHaveBeenCalled();

    localStorage.setItem("nekodesk_compact_old", "요약");
    expect(await pruneOldSessions(30, t0 + 30 * DAY)).toEqual(["old"]);
    expect(prune).toHaveBeenCalledWith(30, ["open"]);
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["open"]);
    expect(localStorage.getItem("nekodesk_compact_old")).toBeNull();
  });
});

describe("세션 목록 DB", () => {
  it("처음엔 지금 목록과 수동 요약을 DB 로 옮기고, 그 뒤엔 DB 값으로 덮는다", async () => {
    localStorage.setItem("nekodesk_compact_old", "요약");
    await hydrateSessions(1000);
    expect(db.rows.map((r) => [r.id, r.created_at, r.summary])).toEqual([["open", 1000, null], ["old", 999, "요약"]]);
    expect(useSessionStore.getState().sessions[1].summary).toBe("요약");

    // 다른 기기에서 열린 세션을 지웠다 → 남은 것으로 옮긴다
    db.rows = [{ id: "old", title: "b", created_at: 999, summary: null }]; // 이미 옮겼으니 이번엔 그대로 읽는다
    await hydrateSessions();
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["old"]);
    expect(useSessionStore.getState().activeId).toBe("old");
    expect(db.deleted).toEqual([]); // 받은 목록을 다시 지우러 가지 않는다
  });

  it("setSessions 는 새 세션·바뀐 제목만 적고, 목록에서 빠졌다고 DB 에서 지우지 않는다", () => {
    // 낡은 목록으로 덮어도(다른 기기에서 온 old 를 모름) old 가 지움으로 올라가지 않는다
    useSessionStore.getState().setSessions((prev) => [{ id: "new", title: "새", date: "" }, { ...prev[0], title: "고친 제목" }]);
    expect(db.put.sort()).toEqual(["new", "open"]);
    expect(db.deleted).toEqual([]);
  });
});

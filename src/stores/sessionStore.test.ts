// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const prune = vi.fn(async (_days: number, _keep: string[]) => ["old"]);
const db = { failImport: false, rows: [] as { id: string; title: string; created_at: number; summary: string | null; unread?: boolean }[], deleted: [] as string[], put: [] as string[], read: [] as string[] };
vi.mock("../api/tauri", () => ({
  conversationApi: { prune: (d: number, k: string[]) => prune(d, k) },
  sessionApi: {
    list: async () => db.rows,
    import: async (rows: typeof db.rows) => { if (db.failImport) throw new Error("앱이 꺼졌다"); db.rows = rows; },
    put: async (id: string) => { db.put.push(id); },
    delete: async (id: string) => { db.deleted.push(id); },
    read: async (id: string) => { db.read.push(id); },
    compact: async () => {},
  },
}));

import { hydrateSessions, pruneOldSessions, relistSessions, useSessionStore } from "./sessionStore";

const DAY = 86_400_000;

beforeEach(() => {
  localStorage.clear();
  prune.mockClear();
  db.rows = []; db.deleted = []; db.put = []; db.read = []; db.failImport = false;
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

  it("질문·답을 적은 뒤 DB 순서(마지막 메시지 순)로 다시 읽는다. 열린 세션이 아직 DB 에 없으면 두고 넘어간다", async () => {
    const ids = () => useSessionStore.getState().sessions.map((s) => s.id);
    db.rows = [{ id: "old", title: "b", created_at: 1, summary: null }, { id: "open", title: "a", created_at: 2, summary: null }];
    relistSessions();
    await vi.waitFor(() => expect(ids()).toEqual(["old", "open"]));
    expect(useSessionStore.getState().activeId).toBe("open");
    // 막 만든 세션(열림)이 아직 안 적혔다: 목록에서 빠져 다른 세션이 열리는 일이 없게 그대로 둔다
    useSessionStore.setState({ sessions: [{ id: "fresh", title: "새 대화", date: "" }, ...useSessionStore.getState().sessions], activeId: "fresh" });
    relistSessions();
    await new Promise((r) => setTimeout(r, 0));
    expect(ids()).toEqual(["fresh", "old", "open"]);
    expect(useSessionStore.getState().activeId).toBe("fresh");
  });

  it("setSessions 는 새 세션·바뀐 제목만 적고, 목록에서 빠졌다고 DB 에서 지우지 않는다", () => {
    // 낡은 목록으로 덮어도(다른 기기에서 온 old 를 모름) old 가 지움으로 올라가지 않는다
    useSessionStore.getState().setSessions((prev) => [{ id: "new", title: "새", date: "" }, { ...prev[0], title: "고친 제목" }]);
    expect(db.put.sort()).toEqual(["new", "open"]);
    expect(db.deleted).toEqual([]);
  });
});

describe("새 답 점", () => {
  const unread = () => useSessionStore.getState().sessions.filter((s) => s.unread).map((s) => s.id);

  it("열려 있지 않은 대화에 답이 끝나면 점, 열면 지우고 읽은 때를 적는다(떠난 대화도)", () => {
    const { replied, setActiveId } = useSessionStore.getState();
    replied("open");
    expect(unread()).toEqual([]);
    expect(db.read).toEqual(["open"]);
    replied("old");
    expect(unread()).toEqual(["old"]);
    setActiveId("old");
    expect(unread()).toEqual([]);
    expect(db.read).toEqual(["open", "open", "old"]);
  });

  it("DB 목록의 새 답은 열린 대화만 빼고 단다(열린 대화는 읽음으로 적는다)", async () => {
    localStorage.setItem("nekodesk_sessions_in_db", "1");
    db.rows = [{ id: "open", title: "a", created_at: 2, summary: null, unread: true }, { id: "old", title: "b", created_at: 1, summary: null, unread: true }];
    await hydrateSessions();
    expect(unread()).toEqual(["old"]);
    expect(db.read).toEqual(["open"]);
  });
});

describe("배포본 첫 실행: localStorage → DB", () => {
  it("옮기다 끊기면 다음에 다시 옮기고, 옮긴 뒤에도 localStorage 는 남긴다(되돌릴 길)", async () => {
    localStorage.setItem("nekodesk_compact_old", "요약");
    db.failImport = true;
    await expect(hydrateSessions(1000)).rejects.toThrow();
    expect(useSessionStore.getState().sessions.map((s) => s.id)).toEqual(["open", "old"]); // 화면은 그대로
    db.failImport = false;
    await hydrateSessions(1000);
    expect(db.rows.map((r) => r.id)).toEqual(["open", "old"]);
    expect(JSON.parse(localStorage.getItem("nekodesk_sessions")!).map((s: { id: string }) => s.id)).toEqual(["open", "old"]);
    expect(localStorage.getItem("nekodesk_compact_old")).toBe("요약");
  });

  it("수동 요약은 예전 자리(localStorage)에도 적는다", async () => {
    await useSessionStore.getState().compact("open", "새 요약");
    expect(localStorage.getItem("nekodesk_compact_open")).toBe("새 요약");
  });
});

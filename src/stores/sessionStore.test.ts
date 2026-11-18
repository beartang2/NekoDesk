// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const prune = vi.fn(async (_days: number, _keep: string[]) => ["old"]);
vi.mock("../api/tauri", () => ({ conversationApi: { prune: (d: number, k: string[]) => prune(d, k) } }));

import { pruneOldSessions, useSessionStore } from "./sessionStore";

const DAY = 86_400_000;

beforeEach(() => {
  localStorage.clear();
  prune.mockClear();
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

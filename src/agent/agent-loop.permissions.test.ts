import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTurn, FsDecision, LoopEvent } from "./types";

/**
 * 승인 게이트의 **순서**를 확인한다: 확인을 받기 전에는 어떤 부작용도 일어나면
 * 안 된다. 모델 없이 턴을 직접 주입해 결정적으로 돌린다.
 */

const calls: string[] = [];

const fsApi = {
  read: vi.fn(async () => ({ content: "", total_lines: 0, truncated: false })),
  write: vi.fn(async (path: string, content: string, approved: boolean) => {
    calls.push(`write(${path}, approved=${approved})`);
    return { path, bytes: content.length, lines: 1, preview: `     1→${content}` };
  }),
  edit: vi.fn(async () => ({ replaced: 1, preview: "     1→바뀐 내용" })),
  list: vi.fn(async () => []),
  glob: vi.fn(async () => []),
  grep: vi.fn(async () => []),
  check: vi.fn(async (path: string): Promise<FsDecision> => ({ kind: "confirm", path })),
};

vi.mock("../api/tauri", () => ({
  todosApi: { list: vi.fn(async () => []), listDone: vi.fn(), add: vi.fn(), complete: vi.fn() },
  scheduleApi: { list: vi.fn(async () => []), add: vi.fn(), delete: vi.fn() },
  execHistoryApi: { save: vi.fn(async () => {}) },
  conversationApi: { save: vi.fn() },
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
  fsApi,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("../lib/events", () => ({
  appEvents: { emit: vi.fn() },
  requestWordchainFirstWord: vi.fn(),
}));
vi.mock("./file-store", () => ({ getFile: vi.fn(), getStoredFileNames: vi.fn(() => []) }));

/** 모델이 낼 턴을 미리 정해 순서대로 돌려준다. */
let scriptedTurns: AgentTurn[] = [];
vi.mock("./llm-client", () => ({
  getModelContextLength: () => 8192,
  agentTurnStream: async function* () {
    const turn = scriptedTurns.shift() ?? { text: "끝", toolCalls: [] };
    yield { type: "turn" as const, turn };
  },
  chatStream: async function* () {
    yield { content: "", done: true };
  },
}));

async function drain(
  input: string,
  onConfirm: (ev: Extract<LoopEvent, { type: "confirm_needed" }>) => void
): Promise<LoopEvent[]> {
  const { runAgentLoop } = await import("./agent-loop");
  const seen: LoopEvent[] = [];
  for await (const ev of runAgentLoop(input, [])) {
    seen.push(ev);
    if (ev.type === "confirm_needed") onConfirm(ev);
  }
  return seen;
}

beforeEach(() => {
  calls.length = 0;
  vi.clearAllMocks();
  fsApi.check.mockImplementation(async (path: string): Promise<FsDecision> => ({ kind: "confirm", path }));
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

const writeTurn: AgentTurn = {
  text: "",
  toolCalls: [
    { id: "c1", name: "fs.write", params: { path: "/tmp/neko/a.txt", content: "냐옹" } },
  ],
};

describe("파일 쓰기 승인 게이트", () => {
  it("확인을 받기 전에는 파일을 건드리지 않는다", async () => {
    scriptedTurns = [writeTurn, { text: "썼어", toolCalls: [] }];
    let sawConfirmBeforeWrite = false;

    await drain("파일 써줘", (ev) => {
      sawConfirmBeforeWrite = calls.length === 0;
      ev.resolve("allow_once");
    });

    expect(sawConfirmBeforeWrite, "확인 전에 이미 썼다").toBe(true);
    expect(calls).toEqual(["write(/tmp/neko/a.txt, approved=true)"]);
  });

  it("거부하면 쓰지 않고 루프가 끝난다", async () => {
    scriptedTurns = [writeTurn, { text: "안 씀", toolCalls: [] }];

    const events = await drain("파일 써줘", (ev) => ev.resolve("deny"));

    expect(calls).toEqual([]);
    const done = events.find((e) => e.type === "done");
    expect(done).toMatchObject({ answer: "실행을 취소했어." });
  });

  it("규칙 키는 파일이 아니라 부모 디렉토리다", async () => {
    scriptedTurns = [writeTurn, { text: "ok", toolCalls: [] }];
    let ruleKey = "";
    await drain("파일 써줘", (ev) => { ruleKey = ev.ruleKey; ev.resolve("allow_once"); });
    expect(ruleKey).toBe("fs.write:/tmp/neko");
  });

  it("백엔드가 이미 허용한 경로면 확인 없이 지나간다", async () => {
    fsApi.check.mockImplementation(async (path: string): Promise<FsDecision> => ({ kind: "allow", path }));
    scriptedTurns = [writeTurn, { text: "ok", toolCalls: [] }];

    let asked = false;
    await drain("파일 써줘", () => { asked = true; });

    expect(asked).toBe(false);
    expect(calls).toEqual(["write(/tmp/neko/a.txt, approved=false)"]);
  });

  it("하드 차단된 경로는 확인 창조차 띄우지 않고 에러가 된다", async () => {
    fsApi.check.mockImplementation(async (path: string): Promise<FsDecision> => ({
      kind: "deny",
      path,
      reason: "민감한 파일이라 접근할 수 없어: .env",
    }));
    scriptedTurns = [
      { text: "", toolCalls: [{ id: "c1", name: "fs.write", params: { path: "/tmp/.env", content: "x" } }] },
      { text: "못 했어", toolCalls: [] },
    ];

    let asked = false;
    const events = await drain("파일 써줘", () => { asked = true; });

    expect(asked, "차단된 경로에 확인 창을 띄웠다").toBe(false);
    expect(calls).toEqual([]);
    const stepError = events.find((e) => e.type === "step_error");
    expect(stepError).toMatchObject({ step: { summary: expect.stringContaining("민감한 파일") } });
  });

  it("세션 승인을 받으면 같은 디렉토리의 다음 쓰기는 안 묻는다", async () => {
    scriptedTurns = [
      writeTurn,
      { text: "", toolCalls: [{ id: "c2", name: "fs.write", params: { path: "/tmp/neko/b.txt", content: "야옹" } }] },
      { text: "둘 다 썼어", toolCalls: [] },
    ];

    let askCount = 0;
    await drain("두 개 써줘", (ev) => { askCount++; ev.resolve("allow_session"); });

    expect(askCount).toBe(1);
    expect(calls).toEqual([
      "write(/tmp/neko/a.txt, approved=true)",
      "write(/tmp/neko/b.txt, approved=true)",
    ]);
  });
});

describe("code.exec 승인 게이트", () => {
  const dangerous: AgentTurn = {
    text: "",
    toolCalls: [
      { id: "c1", name: "code.exec", params: { code: "rm -rf /tmp/x", language: "shell" } },
    ],
  };

  it("위험 패턴은 세션 승인을 받아둬도 매번 다시 묻는다", async () => {
    scriptedTurns = [
      dangerous,
      { ...dangerous, toolCalls: [{ ...dangerous.toolCalls[0], id: "c2" }] },
      { text: "끝", toolCalls: [] },
    ];

    const reasons: string[] = [];
    await drain("지워줘", (ev) => {
      reasons.push(ev.dangerReason);
      ev.resolve("allow_session");
    });

    expect(reasons).toHaveLength(2);
    expect(reasons[0]).toContain("강제 삭제");
  });

  it("부작용 없는 조회는 확인 없이 실행된다", async () => {
    scriptedTurns = [
      { text: "", toolCalls: [{ id: "c1", name: "code.exec", params: { code: "date", language: "shell" } }] },
      { text: "끝", toolCalls: [] },
    ];

    let asked = false;
    await drain("몇 시야", () => { asked = true; });
    expect(asked).toBe(false);
  });
});

describe("쓰기 결과 검증", () => {
  it("저장된 실제 내용이 툴 결과로 모델에게 돌아간다", async () => {
    scriptedTurns = [writeTurn, { text: "썼어", toolCalls: [] }];

    const { runAgentLoop } = await import("./agent-loop");
    const steps: string[] = [];
    for await (const ev of runAgentLoop("파일 써줘", [])) {
      if (ev.type === "confirm_needed") ev.resolve("allow_once");
      if (ev.type === "step_done") steps.push(ev.step.summary);
    }

    // "저장됨" 한 줄이 아니라 되읽은 내용이 실려야 한다.
    expect(steps[0]).toContain("실제 저장된 내용");
    expect(steps[0]).toContain("냐옹");
  });
});

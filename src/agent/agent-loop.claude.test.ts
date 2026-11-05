// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTurn, LlmMessage, LoopEvent } from "./types";
import { useSettingsStore } from "../stores/settingsStore";

/**
 * Claude 프로필의 루프는 Claude Code 처럼 돈다: 모델이 툴 없이 답할 때까지 이어 가고,
 * 툴 오류는 그대로 돌려준다. 힌트·잠금·실패 횟수로 끊기·반복 끊기는 작은 로컬 모델용이다.
 * 끝없이 돌면 사용자가 멈춘다 — 상한은 턴 100 하나뿐이다.
 */

vi.mock("../api/tauri", () => ({
  todosApi: { list: vi.fn(async () => { throw new Error("DB 잠김"); }) },
  execHistoryApi: { save: vi.fn(async () => {}) },
  conversationApi: { save: vi.fn() },
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
  fsApi: { check: vi.fn(async (path: string) => ({ kind: "allow" as const, path })) },
}));
vi.mock("../lib/events", () => ({ appEvents: { emit: vi.fn() }, requestWordchainFirstWord: vi.fn() }));
vi.mock("./file-store", () => ({ getFile: vi.fn(), getStoredFileNames: vi.fn(() => []) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));

let nextTurn: (i: number) => AgentTurn = () => ({ text: "끝", toolCalls: [] });
let turnIndex = 0;
let sent: LlmMessage[][] = [];
vi.mock("./llm-client", () => ({
  getModelContextLength: () => 64_000,
  agentContextPrefix: () => "[현재 날짜/시각: 고정]\n\n",
  agentTurnStream: async function* (messages: LlmMessage[]) {
    sent.push(messages);
    yield { type: "turn" as const, turn: nextTurn(turnIndex++) };
  },
  chatStream: async function* () {
    yield { content: "상한에 걸려 정리했어", done: true };
  },
}));

async function run(history: LlmMessage[] = []): Promise<LoopEvent[]> {
  const { runAgentLoop } = await import("./agent-loop");
  const events: LoopEvent[] = [];
  for await (const ev of runAgentLoop("해줘", history)) events.push(ev);
  return events;
}

const call = (i: number, name: string, params: Record<string, unknown> = {}): AgentTurn => ({
  text: "",
  toolCalls: [{ id: `c${i}`, name, params }],
});

beforeEach(() => {
  turnIndex = 0;
  sent = [];
  useSettingsStore.setState({ llmUrl: "claude://claude-haiku-5-5" });
});

describe("Claude 프로필 루프", () => {
  it("같은 오류가 여러 번 나도 끊지 않고, 오류는 힌트 없이 그대로 돌려준다", async () => {
    nextTurn = (i) => (i < 6 ? call(i, "todo.list") : { text: "할 일 DB 가 잠겨 있어서 못 봤어", toolCalls: [] });

    const events = await run();
    const errors = events.filter((e) => e.type === "step_error");
    expect(errors).toHaveLength(6);
    for (const e of errors) {
      expect(e.type === "step_error" && e.step.summary).not.toMatch(/자동 힌트|반복 실패|잠겼어/);
    }
    expect(events.find((e) => e.type === "done")).toMatchObject({ answer: "할 일 DB 가 잠겨 있어서 못 봤어" });
  });

  it("같은 스킬을 또 읽으면 이미 읽었다고만 알리고, 모델이 끝낼 때까지 이어 간다", async () => {
    nextTurn = (i) => (i < 4 ? call(i, "skill.read", { name: "AppleScript/Music" }) : { text: "다 읽었어", toolCalls: [] });

    const events = await run();
    const reads = events.filter((e) => e.type === "step_done" && e.step.tool === "skill.read");
    expect(reads).toHaveLength(4);
    expect(events.find((e) => e.type === "done")).toMatchObject({ answer: "다 읽었어" });
  });

  it("매 턴 보내는 메시지는 앞쪽이 그대로다 — 시각은 현재 질문에 한 번만, 계획은 덧붙이기만", async () => {
    const history: LlmMessage[] = Array.from({ length: 60 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `지난 대화 ${i} ${"내용".repeat(200)}`,
    }));
    nextTurn = (i) =>
      i === 0 ? call(i, "plan.set", { steps: ["보기", "고치기"] })
      : i < 5 ? call(i, "skill.read", { name: `스킬 ${i}` })
      : { text: "끝", toolCalls: [] };

    await run(history);
    expect(sent).toHaveLength(6);
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].slice(0, sent[i - 1].length)).toEqual(sent[i - 1]);
    }
    const prefixed = sent[5].filter((m) => String(typeof m.content === "string" ? m.content : JSON.stringify(m.content)).includes("[현재 날짜/시각"));
    expect(prefixed).toHaveLength(1);
    expect(prefixed[0]).toMatchObject({ role: "user", content: "[현재 날짜/시각: 고정]\n\n해줘" });
    expect(sent[5].some((m) => m.role === "tool" && String(m.content).includes("[계획]"))).toBe(true);
  });

  it("턴 100 에서 멈춘다", async () => {
    nextTurn = (i) => call(i, "skill.read", { name: `없는 스킬 ${i}` });

    const events = await run();
    expect(turnIndex).toBe(100);
    expect(events.find((e) => e.type === "done")).toMatchObject({ answer: "상한에 걸려 정리했어" });
  });
});

describe("Claude 로 나가기 전 확인", () => {
  it("툴 결과에 주민등록번호가 있으면 묻고, 거부하면 그 값만 가려서 보낸다", async () => {
    const { todosApi } = await import("../api/tauri");
    vi.mocked(todosApi.list).mockResolvedValueOnce([
      { id: 1, content: "서류에 900101-1234567 적기", completed: false, created_at: "2026-11-05 00:00:00" },
    ] as never);
    nextTurn = (i) => (i === 0 ? call(i, "todo.list") : { text: "했어", toolCalls: [] });

    const { runAgentLoop } = await import("./agent-loop");
    const confirms: string[] = [];
    for await (const ev of runAgentLoop("해줘", [])) {
      if (ev.type === "confirm_needed") {
        confirms.push(ev.code);
        ev.resolve("deny");
      }
    }
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain("주민등록번호처럼 보이는 값 1개");
    const toModel = JSON.stringify(sent[1]);
    expect(toModel).not.toContain("1234567");
    expect(toModel).toContain("‹주민등록번호 가림›");
  });

  it("오류로 끝난 결과도 거친다 — stderr 에 읽은 내용이 섞여 나온다", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      cmd === "code_exec" ? { stdout: "", stderr: "파싱 실패: 900101-1234567", exit_code: 1 } : {});
    nextTurn = (i) => (i === 0 ? call(i, "code.exec", { language: "python", code: "print(1)" }) : { text: "했어", toolCalls: [] });
    const { runAgentLoop } = await import("./agent-loop");
    let asked = 0;
    for await (const ev of runAgentLoop("해줘", [])) {
      if (ev.type === "confirm_needed") {
        if (ev.language === "Claude 로 보내기") { asked++; ev.resolve("deny"); } else ev.resolve("allow_once");
      }
    }
    expect(asked).toBe(1);
    expect(JSON.stringify(sent[1])).not.toContain("1234567");
    vi.mocked(invoke).mockImplementation(async () => ({}));
  });
});

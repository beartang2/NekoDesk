// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTurn, LoopEvent } from "./types";
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
vi.mock("./llm-client", () => ({
  getModelContextLength: () => 64_000,
  agentTurnStream: async function* () {
    yield { type: "turn" as const, turn: nextTurn(turnIndex++) };
  },
  chatStream: async function* () {
    yield { content: "상한에 걸려 정리했어", done: true };
  },
}));

async function run(): Promise<LoopEvent[]> {
  const { runAgentLoop } = await import("./agent-loop");
  const events: LoopEvent[] = [];
  for await (const ev of runAgentLoop("해줘", [])) events.push(ev);
  return events;
}

const call = (i: number, name: string, params: Record<string, unknown> = {}): AgentTurn => ({
  text: "",
  toolCalls: [{ id: `c${i}`, name, params }],
});

beforeEach(() => {
  turnIndex = 0;
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

  it("턴 100 에서 멈춘다", async () => {
    nextTurn = (i) => call(i, "skill.read", { name: `없는 스킬 ${i}` });

    const events = await run();
    expect(turnIndex).toBe(100);
    expect(events.find((e) => e.type === "done")).toMatchObject({ answer: "상한에 걸려 정리했어" });
  });
});

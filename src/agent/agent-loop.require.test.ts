import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentTurn, LlmMessage, LoopEvent } from "./types";

/**
 * requireTool: 결과를 툴 인자로 받아야 하는 요청에서, 모델이 툴 없이 말로만
 * 끝내려 하면 루프가 재촉한다. 끝말잇기 이의 제기에서 4B 모델이 "내가 졌어" 만
 * 쓰고 게임을 안 끝낸 게 계기다.
 */

const emit = vi.fn();
vi.mock("../lib/events", () => ({ appEvents: { emit: (...a: unknown[]) => emit(...a) }, requestWordchainFirstWord: vi.fn() }));
vi.mock("../api/tauri", () => ({ conversationApi: { save: vi.fn() }, memoryApi: { search: vi.fn(async () => []) } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("./file-store", () => ({ getFile: vi.fn(), getStoredFileNames: vi.fn(() => []) }));

let turns: AgentTurn[] = [];
let sent: LlmMessage[][] = [];
vi.mock("./llm-client", () => ({
  getModelContextLength: () => 8192,
  agentTurnStream: async function* (messages: LlmMessage[]) {
    sent.push(messages);
    yield { type: "turn" as const, turn: turns.shift() ?? { text: "끝", toolCalls: [] } };
  },
  chatStream: async function* () {
    yield { content: "정리했어", done: true };
  },
}));

async function run(): Promise<LoopEvent[]> {
  const { runAgentLoop } = await import("./agent-loop");
  const events: LoopEvent[] = [];
  for await (const ev of runAgentLoop("이의 제기", [], undefined, undefined, undefined, "game.judge")) events.push(ev);
  return events;
}

const say = (text: string): AgentTurn => ({ text, toolCalls: [] });
const judge = (exists: boolean): AgentTurn => ({
  text: "",
  toolCalls: [{ id: "j1", name: "game.judge", params: { exists } }],
});

beforeEach(() => {
  turns = [];
  sent = [];
  emit.mockClear();
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe("requireTool", () => {
  it("툴 없이 끝내려 하면 재촉하고, 부르면 그 판정이 앱에 전해진다", async () => {
    turns = [say("내가 졌어!"), judge(false), say("없는 말이었어. 내가 졌어!")];

    const events = await run();

    // 두 번째 호출엔 모델이 했던 말과 재촉이 같이 실린다 — 안 그러면 같은 답을 되풀이한다.
    const second = sent[1].map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(second).toContain("내가 졌어!");
    expect(second).toContain("game.judge 를 불러서");
    expect(emit).toHaveBeenCalledWith("wordchainVerdict", { exists: false });
    expect(events[events.length - 1]).toMatchObject({ type: "done", answer: "없는 말이었어. 내가 졌어!" });
  });

  it("처음부터 부르면 재촉하지 않는다", async () => {
    turns = [judge(true), say("있는 말이야. 계속하자!")];
    await run();
    expect(sent).toHaveLength(2);
    expect(emit).toHaveBeenCalledWith("wordchainVerdict", { exists: true });
  });

  it("두 번 재촉해도 안 부르면 그냥 끝낸다 — 붙잡아 두지 않는다", async () => {
    turns = [say("하나"), say("둘"), say("셋")];
    const events = await run();
    expect(sent).toHaveLength(3);
    expect(emit).not.toHaveBeenCalled();
    expect(events[events.length - 1]).toMatchObject({ type: "done", answer: "셋" });
  });
});

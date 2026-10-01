import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LoopEvent } from "./types";

/**
 * 답이 흐르는 도중에 끊는 두 경우: 사용자가 말을 보냈을 때, 같은 말이 반복될 때.
 * 4B 모델이 "多少钱多少钱…" 에 갇혀 2분 동안 끼어들 수 없었던 게 계기다.
 */

vi.mock("../lib/events", () => ({ appEvents: { emit: vi.fn() }, requestWordchainFirstWord: vi.fn() }));
vi.mock("../api/tauri", () => ({ conversationApi: { save: vi.fn() }, memoryApi: { search: vi.fn(async () => []) } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("./file-store", () => ({ getFile: vi.fn(), getStoredFileNames: vi.fn(() => []) }));

/** 모델이 흘릴 조각들. 루프가 끊으면 나머지는 안 읽힌다. */
let chunks: string[] = [];
let pulled = 0;
vi.mock("./llm-client", () => ({
  getModelContextLength: () => 8192,
  agentTurnStream: async function* () {
    for (const text of chunks) {
      pulled++;
      yield { type: "delta" as const, text };
    }
    yield { type: "turn" as const, turn: { text: chunks.join(""), toolCalls: [] } };
  },
  chatStream: async function* () {
    yield { content: "정리했어", done: true };
  },
}));

async function run(hasInterjections?: () => boolean): Promise<LoopEvent[]> {
  const { runAgentLoop } = await import("./agent-loop");
  const events: LoopEvent[] = [];
  for await (const ev of runAgentLoop("해줘", [], undefined, undefined, undefined, undefined, hasInterjections)) events.push(ev);
  return events;
}
const last = (events: LoopEvent[]) => events[events.length - 1];

beforeEach(() => {
  chunks = [];
  pulled = 0;
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe("degenerateAt", () => {
  it("한 구절에 갇힌 꼬리를 찾고, 첫 번째 것까지만 남길 자리를 준다", async () => {
    const { degenerateAt } = await import("./agent-loop");
    const text = "얼마예요? " + "多少钱".repeat(40);
    expect(text.slice(0, degenerateAt(text)!)).toBe("얼마예요? 多少钱");
  });

  it("평범한 답, 짧은 ㅋㅋ, 마크다운 구분선은 반복으로 안 본다", async () => {
    const { degenerateAt } = await import("./agent-loop");
    expect(degenerateAt("홍콩에선 唔該(m4 goi1) 하나로 고마워·실례해요를 다 해.")).toBeNull();
    expect(degenerateAt("ㅋㅋㅋㅋㅋㅋㅋㅋㅋㅋ")).toBeNull();
    expect(degenerateAt("| 표현 | 뜻 |\n| --- | --- |\n| 唔該 | 고마워 |")).toBeNull();
  });
});

describe("답 도중 끊기", () => {
  it("같은 말이 반복되면 그 자리에서 끊고, 반복 전까지만 답으로 남긴다", async () => {
    chunks = ["이거 얼마예요? ", ...Array(200).fill("多少钱")];
    const events = await run();
    expect(last(events)).toMatchObject({ type: "done", answer: "이거 얼마예요? 多少钱\n\n(같은 말이 반복돼서 끊었어)" });
    // 끝까지 받지 않았다 — 서버 생성도 여기서 멈춘다.
    expect(pulled).toBeLessThan(40);
  });

  it("대기 중인 말이 생기면 다음 조각에서 끊는다", async () => {
    chunks = ["광둥어로 ", "고마워는 ", "唔該", " 이고", " 또…"];
    const events = await run(() => pulled >= 3);
    expect(last(events)).toMatchObject({ type: "done", answer: "광둥어로 고마워는 唔該\n\n(말을 걸어서 여기서 멈췄어)" });
    expect(pulled).toBe(3);
  });

  it("끼어든 게 없으면 끝까지 받는다", async () => {
    chunks = ["唔該", "는 ", "고마워"];
    const events = await run(() => false);
    expect(last(events)).toMatchObject({ type: "done", answer: "唔該는 고마워" });
  });
});

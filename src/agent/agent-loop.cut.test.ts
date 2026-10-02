import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContentPart, LlmMessage, LoopEvent } from "./types";

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
let thinking: string[] = [];
/** 두 번째 호출부터 흘릴 조각. */
let later: string[][] = [];
let pulled = 0;
let sent: LlmMessage[][] = [];
vi.mock("./llm-client", () => ({
  getModelContextLength: () => 8192,
  agentTurnStream: async function* (messages: LlmMessage[]) {
    sent.push(messages);
    const first = sent.length === 1;
    const mine = first ? chunks : later.shift() ?? [];
    for (const text of first ? thinking : []) {
      pulled++;
      yield { type: "thinking" as const, text };
    }
    for (const text of mine) {
      pulled++;
      yield { type: "delta" as const, text };
    }
    yield { type: "turn" as const, turn: { text: mine.join(""), toolCalls: [] } };
  },
  chatStream: async function* () {
    yield { content: "정리했어", done: true };
  },
}));

async function run(
  hasInterjections?: () => boolean,
  takeInterjections?: () => (string | ContentPart[])[]
): Promise<LoopEvent[]> {
  const { runAgentLoop } = await import("./agent-loop");
  const events: LoopEvent[] = [];
  for await (const ev of runAgentLoop("해줘", [], undefined, undefined, takeInterjections, undefined, hasInterjections)) events.push(ev);
  return events;
}
const last = (events: LoopEvent[]) => events[events.length - 1];

beforeEach(() => {
  chunks = [];
  thinking = [];
  later = [];
  sent = [];
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

  it("긴 문단을 통째로 되풀이하는 것도 잡는다 — 생각이 맴돌 때의 모양", async () => {
    const { degenerateAt } = await import("./agent-loop");
    const loop = "사용자가 묻는 건 나(고양이)의 취향이니까, 기억으로 답해야 해. 하지만 좋아하는 음식에 대한 정보가 없어. ";
    const text = "붕어빵 얘기네. " + loop.repeat(6);
    // 첫 바퀴까지만 남는다.
    expect(text.slice(0, degenerateAt(text)!)).toBe("붕어빵 얘기네. " + loop);
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
    // 끊었다는 안내는 답이 아니라 notice 로 간다 — 답에 섞으면 대화 기록으로 모델에게 돌아가 따라 쓴다.
    expect(last(events)).toMatchObject({ type: "done", answer: "이거 얼마예요? 多少钱", notice: "같은 말이 반복돼서 끊었어" });
    // 끝까지 받지 않았다 — 서버 생성도 여기서 멈춘다.
    expect(pulled).toBeLessThan(40);
  });

  it("생성 도중 말을 걸면 하던 생성을 버리고, 원래 질문과 새 말을 같이 보고 다시 답한다", async () => {
    // 예전엔 "(말을 걸어서 여기서 멈췄어)" 로 끝내서 처음 질문은 답을 못 받았다.
    chunks = ["광둥어로 ", "고마워는 ", "唔該", " 이고", " 또…"];
    later = [["고마워는 唔該야. ", "짧게 할게!"]];
    let queue = ["짧게 말해줘"];
    const events = await run(
      () => queue.length > 0 && pulled >= 3,
      () => { const taken = queue; queue = []; return taken; }
    );

    expect(events.some((e) => e.type === "user_interjected")).toBe(true);
    expect(last(events)).toMatchObject({ type: "done", answer: "고마워는 唔該야. 짧게 할게!" });
    // 두 번째 생성엔 원래 질문과 새 말이 다 있고, 버린 조각은 없다.
    const second = sent[1].map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(second).toContain("해줘");
    expect(second).toContain("짧게 말해줘");
    expect(second).not.toContain("광둥어로 고마워는");
  });

  it("생각이 맴돌면 끊고 다시 물어달라고 한다", async () => {
    const loop = "좋아하는 음식이 있을 거라고 생각했는데, 실제로는 정보가 없어. 기억으로 답해야 해. ";
    thinking = Array(30).fill(loop);
    chunks = [];
    const events = await run();
    expect(last(events)).toMatchObject({ type: "done", answer: "", notice: "생각이 같은 자리를 맴돌아서 끊었어. 다시 물어봐줘" });
    expect(pulled).toBeLessThan(10);
  });

  it("끼어든 게 없으면 끝까지 받는다", async () => {
    chunks = ["唔該", "는 ", "고마워"];
    const events = await run(() => false);
    expect(last(events)).toMatchObject({ type: "done", answer: "唔該는 고마워" });
  });
});

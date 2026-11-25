// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { LoopEvent } from "../agent/types";

/**
 * 되묻기·확인은 세션마다 따로(0.1.33): 세션 A 가 되묻는 동안 세션 B 의 답이 끝나도 A 의 질문이 남고, 두 세션이 같이 물으면
 * 둘 다 남는다 — 예전엔 칸이 하나라 B 가 끝나며 A 질문을 지워 A 루프가 대답을 영영 기다렸다
 */
vi.mock("../api/tauri", () => ({ conversationApi: { save: async () => {} }, sessionApi: { list: async () => [], read: async () => {}, put: async () => {} } }));
vi.mock("../lib/notify", () => ({ notifyIfAway: vi.fn(), toNotificationBody: (s: string) => s }));

type Script = () => AsyncGenerator<LoopEvent>;
const scripts = new Map<string, Script>();
vi.mock("../agent/agent-loop", () => ({
  runAgentLoop: (input: string) => scripts.get(input)!(),
}));

import { useAgentPool } from "./useAgentLoop";
import { useMessageStore } from "../stores/messageStore";

beforeEach(() => { scripts.clear(); useMessageStore.setState({ messages: {} }); });

/** 되묻고(clarify_needed) 대답을 기다렸다 답하는 루프. got = 받은 대답 */
function asks(question: string, got: string[]): Script {
  return async function* () {
    let resolve!: (a: string) => void;
    const answer = new Promise<string>((r) => { resolve = r; });
    yield { type: "clarify_needed", question, options: [], resolve };
    got.push(await answer);
    yield { type: "done", answer: "알았어", steps: [] };
  };
}

describe("세션마다 따로 든 되묻기", () => {
  it("A 가 되묻는 동안 B 의 답이 끝나도 A 질문은 남고, A 에 대답하면 A 루프가 이어 끝난다", async () => {
    const gotA: string[] = [];
    scripts.set("A 질문", asks("어느 쪽?", gotA));
    scripts.set("B 질문", async function* () { yield { type: "done", answer: "B 답", steps: [] }; });
    const { result } = renderHook(() => useAgentPool());
    let doneA!: Promise<void>;
    act(() => { doneA = result.current.sendMessage("A", "A 질문"); });
    await waitFor(() => expect(result.current.pendingClarify("A")?.question).toBe("어느 쪽?"));
    await act(async () => { await result.current.sendMessage("B", "B 질문"); });
    expect(result.current.pendingClarify("A")?.question).toBe("어느 쪽?");
    expect(result.current.pendingClarify("B")).toBeNull();
    await act(async () => { result.current.clarifyResolve("A", "왼쪽"); await doneA; });
    expect(gotA).toEqual(["왼쪽"]);
    expect(result.current.pendingClarify("A")).toBeNull();
    expect(result.current.isRunning("A")).toBe(false);
  });

  it("두 세션이 같이 물으면 둘 다 남고(앞의 것이 덮이지 않는다), 멈추면 그 세션 것만 풀린다", async () => {
    const gotA: string[] = [], gotB: string[] = [];
    scripts.set("A", asks("A?", gotA));
    scripts.set("B", asks("B?", gotB));
    const { result } = renderHook(() => useAgentPool());
    let doneA!: Promise<void>, doneB!: Promise<void>;
    act(() => { doneA = result.current.sendMessage("a", "A"); doneB = result.current.sendMessage("b", "B"); });
    await waitFor(() => { expect(result.current.pendingClarify("a")).not.toBeNull(); expect(result.current.pendingClarify("b")).not.toBeNull(); });
    act(() => { result.current.stop("b"); });
    await waitFor(() => expect(gotB).toEqual([""])); // 멈추면 그 세션의 기다림을 풀어 준다(루프가 매달리지 않게)
    void doneB;
    expect(result.current.pendingClarify("a")?.question).toBe("A?");
    await act(async () => { result.current.clarifyResolve("a", "응"); await doneA; });
    expect(gotA).toEqual(["응"]);
  });
});

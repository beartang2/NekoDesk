// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { AgentStep, LoopEvent } from "../agent/types";

/**
 * 네코가 일하는 사이 보낸 말이 어떻게 되는지 본다. 모델은 부르지 않는다 —
 * 루프를 대본대로 흘려보내는 가짜로 바꾼다.
 */
const save = vi.fn(async (..._args: unknown[]) => {});
vi.mock("../api/tauri", () => ({ conversationApi: { save: (...args: unknown[]) => save(...args) } }));
vi.mock("../lib/notify", () => ({ notifyIfAway: vi.fn(), toNotificationBody: (s: string) => s }));

type Take = () => unknown[];
type Script = (take: Take) => AsyncGenerator<LoopEvent>;
const scripts: Script[] = [];
const loopInputs: string[] = [];
vi.mock("../agent/agent-loop", () => ({
  runAgentLoop: (input: string, _h: unknown, _c: unknown, _s: unknown, take: Take) => {
    loopInputs.push(input);
    return scripts.shift()!(take);
  },
}));

import { useAgentPool } from "./useAgentLoop";
import { useMessageStore } from "../stores/messageStore";

const step = (id: number): AgentStep => ({
  id, thought: "", tool: "todo.list", params: {}, result: null, summary: "할 일 없음", status: "done",
});

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { open, opened };
}

const shown = () => useMessageStore.getState().get("s").map((m) => [m.role, m.content]);

beforeEach(() => {
  scripts.length = 0;
  loopInputs.length = 0;
  save.mockClear();
  useMessageStore.setState({ messages: {} });
});

describe("일하는 사이 보낸 말", () => {
  it("도구 사이에 읽히면 답 칸이 나뉜다 — 질문 뒤에 답이 온다", async () => {
    const tools = gate();
    let taken: unknown[] = [];
    scripts.push(async function* (take) {
      yield { type: "step_done", step: step(1) };
      await tools.opened; // 다음 도구가 도는 사이
      taken = take();
      yield { type: "user_interjected", stepCount: 1 };
      yield { type: "step_done", step: step(2) };
      yield { type: "streaming_token", token: "둘 다 봤어" };
      yield { type: "done", answer: "둘 다 봤어", steps: [step(1), step(2)] };
    });

    const { result } = renderHook(() => useAgentPool());
    let first!: Promise<void>;
    act(() => { first = result.current.sendMessage("s", "할 일 보여줘"); });
    await waitFor(() => expect(useMessageStore.getState().get("s")[1]?.steps).toHaveLength(1));

    await act(async () => { await result.current.sendMessage("s", "일정도 봐줘"); });
    // 새 요청으로 나가지 않고 줄만 선다. 대화에는 아직 없다.
    expect(result.current.queued("s").map((q) => q.userText)).toEqual(["일정도 봐줘"]);
    expect(loopInputs).toEqual(["할 일 보여줘"]);
    expect(shown()).toHaveLength(2);

    await act(async () => { tools.open(); await first; });

    expect(taken).toEqual(["일정도 봐줘"]);
    expect(result.current.queued("s")).toEqual([]);
    expect(shown()).toEqual([
      ["user", "할 일 보여줘"],
      ["assistant", ""],
      ["user", "일정도 봐줘"],
      ["assistant", "둘 다 봤어"],
    ]);
    const [, before, , after] = useMessageStore.getState().get("s");
    expect(before).toMatchObject({ isStreaming: false, steps: [{ id: 1 }] });
    expect(after).toMatchObject({ isStreaming: false, steps: [{ id: 2 }] });
    // 다시 열었을 때도 같은 순서여야 한다.
    expect(save.mock.calls.map((c) => [c[1], c[2]])).toEqual(shown());
    expect(loopInputs).toHaveLength(1);
  });

  it("끼울 틈 없이 답이 끝나면 다음 요청으로 나간다", async () => {
    const answer = gate();
    scripts.push(async function* () {
      await answer.opened;
      yield { type: "done", answer: "첫 답", steps: [] };
    });
    scripts.push(async function* () {
      yield { type: "done", answer: "둘째 답", steps: [] };
    });

    const { result } = renderHook(() => useAgentPool());
    let first!: Promise<void>;
    act(() => { first = result.current.sendMessage("s", "첫 질문"); });
    await act(async () => { await result.current.sendMessage("s", "나중 질문"); });
    expect(result.current.queued("s")).toHaveLength(1);

    await act(async () => { answer.open(); await first; });
    await waitFor(() => expect(shown()).toEqual([
      ["user", "첫 질문"],
      ["assistant", "첫 답"],
      ["user", "나중 질문"],
      ["assistant", "둘째 답"],
    ]));
    expect(loopInputs).toEqual(["첫 질문", "나중 질문"]);
    expect(result.current.queued("s")).toEqual([]);
    expect(result.current.isRunning("s")).toBe(false);
  });

  it("줄 선 말은 읽히기 전에 뺄 수 있다", async () => {
    const answer = gate();
    scripts.push(async function* () {
      await answer.opened;
      yield { type: "done", answer: "답", steps: [] };
    });

    const { result } = renderHook(() => useAgentPool());
    let first!: Promise<void>;
    act(() => { first = result.current.sendMessage("s", "질문"); });
    await act(async () => { await result.current.sendMessage("s", "잘못 보낸 말"); });
    act(() => result.current.cancelQueued("s", result.current.queued("s")[0].id));
    expect(result.current.queued("s")).toEqual([]);

    await act(async () => { answer.open(); await first; });
    expect(loopInputs).toEqual(["질문"]);
    expect(shown()).toEqual([["user", "질문"], ["assistant", "답"]]);
  });
});

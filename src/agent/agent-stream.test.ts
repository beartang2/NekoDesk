import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * agentStepStream 이 JSON 이 완성되기 전에 finalAnswer 를 흘려보내는지,
 * AbortSignal 이 실제로 fetch 까지 도달하는지 확인한다.
 *
 * llama.cpp 없이 SSE 응답을 흉내낸다.
 */

let lastInit: RequestInit | undefined;

/** OpenAI 호환 SSE 스트림을 만든다. 각 조각이 하나의 delta 청크가 된다. */
function sseResponse(pieces: string[], opts: { holdOpen?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const piece of pieces) {
        const frame = { choices: [{ delta: { content: piece }, finish_reason: null }] };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
        await new Promise((r) => setTimeout(r, 1));
      }
      if (opts.holdOpen) return; // 절대 닫지 않음 → abort 로만 끝난다
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules(); // 설정 스토어(빠른 판단 여부)가 테스트 사이에 새지 않게
  lastInit = undefined;
});

describe("agentStepStream", () => {
  it("JSON 이 다 오기 전에 finalAnswer 를 토큰으로 흘린다 (예전 방식: thought 도 흘린다)", async () => {
    const { agentStepStream } = await import("./llm-client");
    const { useSettingsStore } = await import("../stores/settingsStore");
    useSettingsStore.getState().setFastDecision(false);

    // 모델이 JSON 을 조각내어 뱉는 상황
    const pieces = [
      '{"thought":"인사',
      '한다","tool":"none"',
      ',"finalAnswer":"안녕',
      "하세요 ",
      '🐱"}',
    ];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      lastInit = init;
      return sseResponse(pieces);
    }));

    const deltas: string[] = [];
    const thinking: string[] = [];
    let parsed: unknown;
    for await (const ev of agentStepStream([{ role: "user", content: "안녕" }], "안녕")) {
      if (ev.type === "thinking") thinking.push(ev.text);
      else if (ev.type === "delta") deltas.push(ev.text);
      else parsed = ev.parsed;
    }

    // 여러 번에 걸쳐 흘러나왔어야 한다 (한 방에 덤프된 게 아니라)
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join("")).toBe("안녕하세요 🐱");
    // thought 도 finalAnswer 보다 먼저 스트리밍됐어야 한다
    expect(thinking.join("")).toBe("인사한다");
    expect(parsed).toMatchObject({ tool: "none", finalAnswer: "안녕하세요 🐱" });
  });

  it("스트리밍 요청에 stream:true 와 signal 이 실린다", async () => {
    const { agentStepStream } = await import("./llm-client");
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      lastInit = init;
      return sseResponse(['{"tool":"none","finalAnswer":"x"}']);
    }));

    const ctrl = new AbortController();
    for await (const _ of agentStepStream([{ role: "user", content: "hi" }], "hi", undefined, ctrl.signal)) {
      // drain
    }

    expect(lastInit?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(lastInit?.body)).stream).toBe(true);
  });

  it("stop 하면 진행 중인 fetch 가 실제로 취소된다", async () => {
    const { agentStepStream } = await import("./llm-client");

    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      lastInit = init;
      // 절대 스스로 끝나지 않는 스트림
      return sseResponse(['{"finalAnswer":"영원히'], { holdOpen: true });
    }));

    const ctrl = new AbortController();
    const gen = agentStepStream([{ role: "user", content: "hi" }], "hi", undefined, ctrl.signal);

    const first = await gen.next();
    expect(first.value).toMatchObject({ type: "delta" });

    ctrl.abort();
    // signal 이 fetch 에 전달됐으므로 abort 된 상태여야 한다
    expect((lastInit?.signal as AbortSignal).aborted).toBe(true);

    // generator 를 닫으면 finally 가 돌아 reader 가 정리된다
    await gen.return(undefined as never);
  });
});

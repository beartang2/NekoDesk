import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 워밍업이 실제로 캐시를 데우려면 워밍업 요청과 에이전트 요청의 시스템 메시지가
 * 토큰 단위로 같아야 한다. 한쪽에만 뭔가(예: 현재 시각)를 넣으면 워밍업은 에러
 * 없이 조용히 무의미해진다. 그 불변식을 여기서 고정한다.
 */

type Body = {
  messages: Array<{ role: string; content: unknown }>;
  max_tokens?: number;
  stream?: boolean;
};

let bodies: Body[] = [];

/** 에이전트 스텝 한 번 분량의 OpenAI 호환 SSE 응답. */
function sseResponse(content: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const frame = { choices: [{ delta: { content }, finish_reason: null }] };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

beforeEach(() => {
  bodies = [];
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Body;
      bodies.push(body);
      if (body.stream) {
        return sseResponse('{"thought":"확인","tool":"none","params":{},"finalAnswer":"응"}');
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "." } }] }), {
        status: 200,
      });
    })
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("warmUpModel", () => {
  it("실제 에이전트 요청과 같은 시스템 메시지를 보낸다", async () => {
    const { warmUpModel, agentStepStream } = await import("./llm-client");

    expect(await warmUpModel()).toBe(true);
    const input = "내일 일정 알려줘";
    for await (const _ of agentStepStream([{ role: "user", content: input }], input)) {
      // drain
    }

    expect(bodies).toHaveLength(2);
    const [warm, real] = bodies;
    expect(warm.messages[0].role).toBe("system");
    expect(warm.messages[0]).toEqual(real.messages[0]);
  });

  it("프리필만 시키고 1토큰만 생성한다", async () => {
    const { warmUpModel } = await import("./llm-client");
    await warmUpModel();

    expect(bodies[0].max_tokens).toBe(1);
    expect(bodies[0].stream).toBe(false);
  });

  it("시간이 흘러도 시스템 메시지가 그대로다 (시각이 섞이면 캐시가 매번 깨진다)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { warmUpModel } = await import("./llm-client");

    vi.setSystemTime(new Date(2026, 8, 27, 9, 0, 0));
    await warmUpModel();
    vi.setSystemTime(new Date(2026, 8, 27, 18, 42, 0));
    await warmUpModel();

    expect(bodies[0].messages[0]).toEqual(bodies[1].messages[0]);
  });

  it("서버가 없으면 에러 대신 false 를 준다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const { warmUpModel } = await import("./llm-client");

    expect(await warmUpModel()).toBe(false);
  });
});

describe("waitForLlmReady", () => {
  it("모델 로딩 중(503)이면 기다렸다가 준비되면 true 를 준다", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: ++calls < 3 ? 503 : 200 })));
    const { waitForLlmReady } = await import("./llm-client");

    expect(await waitForLlmReady(1_000, 1)).toBe(true);
    expect(calls).toBe(3);
  });

  it("제한 시간 안에 준비되지 않으면 false 를 준다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    const { waitForLlmReady } = await import("./llm-client");

    expect(await waitForLlmReady(30, 5)).toBe(false);
  });
});

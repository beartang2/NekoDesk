import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 빠른 판단 경로: 생각 없이 확률로 도구를 고르고, 확신이 낮으면 예전 방식으로 다시 판단한다.
 * llama.cpp 없이 logprobs 가 실린 SSE 를 흉내낸다.
 */

type Piece = { text: string; p?: number; alts?: Record<string, number> };

/** 조각마다 토큰 확률을 붙인 OpenAI 호환 SSE. p 가 없으면 확률을 싣지 않는다. */
function sse(pieces: Piece[]): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const { text, p, alts = {} } of pieces) {
        const choice: Record<string, unknown> = { delta: { content: text }, finish_reason: null };
        if (p !== undefined) {
          const top = Object.entries({ [text]: p, ...alts }).map(([token, q]) => ({ token, logprob: Math.log(q) }));
          choice.logprobs = { content: [{ token: text, logprob: Math.log(p), top_logprobs: top }] };
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [choice] })}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const NONE_CONFIDENT: Piece[] = [
  { text: '{"tool":"', p: 1 },
  { text: "none", p: 0.95, alts: { todo: 0.05 } },
  { text: '","', p: 1 },
  { text: 'params":{},"finalAnswer":"', p: 1 },
  { text: "안녕", p: 1 },
  { text: '!"}', p: 1 },
];

const UNSURE: Piece[] = [
  { text: '{"tool":"', p: 1 },
  { text: "code", p: 0.3, alts: { web: 0.35, todo: 0.35 } },
  { text: ".exec", p: 1 },
  { text: '","', p: 1 },
  { text: 'params":{"code":"print(1)"}}', p: 1 },
];

const LEGACY_ANSWER: Piece[] = [
  { text: '{"thought":"검색이 필요해","tool":"web.search","params":{"query":"security news"}}' },
];

let bodies: Array<Record<string, unknown>> = [];

function serve(...responses: Piece[][]) {
  bodies = [];
  let i = 0;
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return sse(responses[Math.min(i++, responses.length - 1)]);
  }));
}

async function run(input = "안녕") {
  const { agentStepStream } = await import("./llm-client");
  const deltas: string[] = [];
  let parsed: import("./types").ParsedAgentStep | undefined;
  for await (const ev of agentStepStream([{ role: "user", content: input }], input)) {
    if (ev.type === "delta") deltas.push(ev.text);
    if (ev.type === "parsed") parsed = ev.parsed;
  }
  return { deltas, parsed: parsed! };
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
  vi.resetModules();
});

describe("빠른 판단", () => {
  it("확신이 높으면 한 번의 요청으로 끝나고, 답변은 그대로 스트리밍된다", async () => {
    serve(NONE_CONFIDENT);
    const { deltas, parsed } = await run();

    expect(bodies).toHaveLength(1);
    expect(parsed).toMatchObject({ tool: "none", finalAnswer: "안녕!", decision: "fast" });
    expect(parsed.confidence).toBeCloseTo(0.95, 3);
    expect(deltas.join("")).toBe("안녕!");
  });

  it("요청에 도구 제한 문법과 토큰 확률 요청이 실린다", async () => {
    serve(NONE_CONFIDENT);
    await run();

    const body = bodies[0];
    expect(body.logprobs).toBe(true);
    expect(body.top_logprobs).toBeGreaterThan(0);
    expect(String(body.grammar)).toContain("tool ::=");
    expect(String(body.grammar)).not.toContain("thought");
  });

  it("확신이 낮으면 끊고 생각하는 방식으로 다시 판단한다", async () => {
    serve(UNSURE, LEGACY_ANSWER);
    const { deltas, parsed } = await run("요즘 보안 이슈 뭐 있어?");

    expect(bodies).toHaveLength(2);
    // 두 번째는 예전 방식: 확률 요청 없이 일반 JSON 문법
    expect(bodies[1].logprobs).toBeUndefined();
    expect(String(bodies[1].grammar)).not.toContain("tool ::=");
    expect(parsed).toMatchObject({ tool: "web.search", thought: "검색이 필요해", decision: "fallback" });
    // 왜 다시 판단했는지 남는다
    expect(parsed.confidence).toBeCloseTo(0.3, 3);
    // 첫 시도는 사용자에게 아무것도 흘리지 않았다
    expect(deltas).toEqual([]);
  });

  it("서버가 확률을 안 주면 확신도 없이 그대로 진행한다", async () => {
    serve(NONE_CONFIDENT.map(({ text }) => ({ text })));
    const { parsed } = await run();

    expect(bodies).toHaveLength(1);
    expect(parsed).toMatchObject({ tool: "none", decision: "fast" });
    expect(parsed.confidence).toBeUndefined();
  });

  it("설정에서 끄면 처음부터 예전 방식으로 판단한다", async () => {
    localStorage.setItem("nekodesk_fast_decision", "false");
    serve(LEGACY_ANSWER);
    const { parsed } = await run("요즘 보안 이슈 뭐 있어?");

    expect(bodies).toHaveLength(1);
    expect(bodies[0].logprobs).toBeUndefined();
    expect(parsed).toMatchObject({ tool: "web.search", decision: "legacy" });
  });
});

import { describe, it, expect, vi, beforeAll } from "vitest";

/** native 모드가 실제로 프롬프트를 얼마나 줄이는지 서버 토크나이저로 잰다. */
const LLM_URL = "http://127.0.0.1:8803";
const serverUp = await fetch(`${LLM_URL}/health`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../api/tauri", () => ({ todosApi: {}, scheduleApi: {}, execHistoryApi: {} }));
vi.mock("../lib/events", () => ({ appEvents: { emit: vi.fn() }, requestWordchainFirstWord: vi.fn() }));
vi.mock("./file-store", () => ({ getFile: vi.fn(), getStoredFileNames: vi.fn(() => []) }));

beforeAll(() => {
  const store = new Map<string, string>([["nekodesk_llm_url", LLM_URL]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

async function countTokens(text: string): Promise<number> {
  const res = await fetch(`${LLM_URL}/tokenize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: text }),
  });
  const data = (await res.json()) as { tokens: number[] };
  return data.tokens.length;
}

/**
 * 서버가 실제로 모델에 먹이는 최종 프롬프트를 잰다.
 * native 모드는 `tools` 가 채팅 템플릿에서 다시 렌더링되므로, 시스템 프롬프트
 * 문자열만 재면 절감량이 과장된다. 템플릿을 통과시킨 뒤에 세야 정직한 숫자다.
 */
async function renderedTokens(
  systemPrompt: string,
  tools?: unknown[]
): Promise<number> {
  const res = await fetch(`${LLM_URL}/apply-template`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: "내 할 일 목록이랑 오늘 일정 같이 보여줘" },
      ],
      ...(tools ? { tools } : {}),
    }),
  });
  const data = (await res.json()) as { prompt: string };
  return countTokens(data.prompt);
}

describe.skipIf(!serverUp)("프롬프트 크기", () => {
  it("모드별 실제 프롬프트 비용을 기록하고 상한을 지킨다", async () => {
    const { __promptsForTest } = await import("./llm-client");
    const { buildToolSchemas } = await import("./tool-schemas");
    const tools = buildToolSchemas();

    const nativeSystem = await countTokens(__promptsForTest.system(true));
    const jsonSystem = await countTokens(__promptsForTest.system(false));
    const emptyTemplate = await renderedTokens("");
    const toolBlock = (await renderedTokens("", tools)) - emptyTemplate;
    const nativeTotal = await renderedTokens(__promptsForTest.system(true), tools);
    const jsonTotal = await renderedTokens(__promptsForTest.system(false));

    console.log(
      [
        `손으로 쓴 시스템 프롬프트 : native ${nativeSystem} / json ${jsonSystem}`,
        `채팅 템플릿의 툴 블록     : ${toolBlock} (native 만 부담)`,
        `최종 프롬프트 합계        : native ${nativeTotal} / json ${jsonTotal}`,
      ].join("\n")
    );

    // native 는 규칙을 덜 싣는다 — 이게 이번 변경으로 실제로 줄인 부분이다.
    expect(nativeSystem).toBeLessThan(jsonSystem);

    // 총합은 오히려 native 가 크다. 템플릿이 툴 스키마를 JSON 원문으로 펼치고
    // 호출 형식 설명까지 붙이기 때문이다. 이 비용은 시스템 프롬프트가 고정이라
    // llama.cpp 프롬프트 캐시에 한 번만 실린다.
    // 상한을 걸어 앞으로 프롬프트·툴 설명이 슬금슬금 불어나는 걸 잡는다.
    expect(nativeTotal).toBeLessThan(4000);
    expect(jsonTotal).toBeLessThan(3000);
  });
});

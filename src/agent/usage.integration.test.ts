import { describe, it, expect, vi, beforeAll } from "vitest";

/** 스트리밍이 끝난 뒤 서버가 주는 prompt_tokens 이 실제로 올라오는지. */
const LLM_URL = "http://127.0.0.1:8803";
const serverUp = await fetch(`${LLM_URL}/health`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

beforeAll(() => {
  const kv = new Map<string, string>([["nekodesk_llm_url", LLM_URL]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => kv.get(k) ?? null,
    setItem: (k: string, v: string) => void kv.set(k, v),
    removeItem: (k: string) => void kv.delete(k),
  });
});

describe.skipIf(!serverUp)("사용량 보고", () => {
  it(
    "스트리밍 응답에서 prompt_tokens 을 받는다",
    async () => {
      const { fetchStream } = await import("./llm-client");
      const seen: number[] = [];

      for await (const chunk of fetchStream(
        [{ role: "user", content: "한 문장으로 인사해줘" }],
        { max_tokens: 24, temperature: 0.1 },
        (pts) => seen.push(pts)
      )) {
        if (chunk.done) break;
      }

      // llama.cpp 는 usage 를 finish_reason 다음 청크에 담는다. 거기서 스트림을
      // 끝내버리면 이 값이 영원히 안 온다 — 게이지가 0 에 멈춰 있던 이유다.
      expect(seen.length, "prompt_tokens 을 한 번도 못 받았다").toBeGreaterThan(0);
      expect(seen[0]).toBeGreaterThan(0);
    },
    120_000
  );
});

import { it, expect, vi, beforeEach, afterEach } from "vitest";

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
});

/** 비스트리밍 완료 응답을 흉내낸다(agentStep → fetchCompletion 경로). */
function completion(content: string): Response {
  return new Response(
    JSON.stringify({ choices: [{ message: { content } }] }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

it("표 안 이스케이프 안 된 따옴표로 JSON 이 깨져도 finalAnswer 를 복구한다", async () => {
  const { agentStep } = await import("./llm-client");
  // 셀에 "React"(이스케이프 안 됨) → JSON.parse 실패 + 엄격 정규식 실패
  const broken =
    '{"thought":"비교","tool":"none","finalAnswer":"| 항목 | 값 |\\n| --- | --- |\\n| 언어 | "React" |\\n| 개발 | Meta |"}';
  vi.stubGlobal("fetch", vi.fn(async () => completion(broken)));

  const parsed = await agentStep([{ role: "user", content: "비교표" }], "비교표");
  expect(parsed.tool).toBe("none");
  // 예전엔 "처리 중 문제가 발생했어" 였음 — 이제 표가 살아있어야
  expect(parsed.finalAnswer).not.toBe("처리 중 문제가 발생했어. 다시 시도해줘.");
  expect(parsed.finalAnswer).toContain("| --- | --- |");
  expect(parsed.finalAnswer).toContain("개발");
});

it("정상 JSON 은 그대로 파싱한다", async () => {
  const { agentStep } = await import("./llm-client");
  const good = '{"thought":"인사","tool":"none","finalAnswer":"안녕하세요 🐱"}';
  vi.stubGlobal("fetch", vi.fn(async () => completion(good)));
  const parsed = await agentStep([{ role: "user", content: "안녕" }], "안녕");
  expect(parsed.finalAnswer).toBe("안녕하세요 🐱");
});

it("<think> 블록이 앞에 붙어도 복구한다", async () => {
  const { agentStep } = await import("./llm-client");
  const withThink =
    '<think>\n\n</think>\n\n{"thought":"t","tool":"none","finalAnswer":"| A | B |\\n| --- | --- |\\n| 1 | "2" |"}';
  vi.stubGlobal("fetch", vi.fn(async () => completion(withThink)));
  const parsed = await agentStep([{ role: "user", content: "표" }], "표");
  expect(parsed.finalAnswer).toContain("| --- | --- |");
});

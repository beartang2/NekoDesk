import { describe, it, expect, vi, beforeAll } from "vitest";

/**
 * 실제 llama-server 를 상대로 도는 통합 테스트. `npm test` 에서는 제외되고
 * `npm run test:integration` 으로만 돈다 (모델 응답에 의존해 느리고 흔들린다).
 *
 * 필요한 것: `llama-server --jinja` 가 LLM_URL 에 떠 있을 것.
 * 확인하는 것: 서버가 한 턴에 툴 여러 개를 돌려주고, 루프가 그걸 실제로 병렬
 * 실행한 뒤 결과를 모델에게 되돌려 최종 답까지 간다.
 */
const LLM_URL = "http://127.0.0.1:8803";

const serverUp = await fetch(`${LLM_URL}/health`, { signal: AbortSignal.timeout(2000) })
  .then((r) => r.ok)
  .catch(() => false);

const todos = [
  { id: 1, content: "우유 사기", status: "open", priority: null, due_at: null, created_at: "", completed_at: null },
];
const events = [
  { id: 3, title: "치과", start_at: "2026-08-27T15:00:00", end_at: null, notes: null, all_day: false, created_at: "" },
];

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("../api/tauri", () => ({
  todosApi: { list: vi.fn(async () => todos), listDone: vi.fn(async () => []), add: vi.fn(), complete: vi.fn() },
  scheduleApi: { list: vi.fn(async () => events), add: vi.fn(), delete: vi.fn() },
  execHistoryApi: { save: vi.fn(async () => {}) },
  conversationApi: { save: vi.fn() },
}));
vi.mock("../lib/events", () => ({
  appEvents: { emit: vi.fn(), on: vi.fn() },
  requestWordchainFirstWord: vi.fn(async () => null),
}));
vi.mock("./file-store", () => ({ getFile: vi.fn(), getStoredFileNames: vi.fn(() => []) }));

beforeAll(() => {
  const store = new Map<string, string>([["nekodesk_llm_url", LLM_URL]]);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

describe.skipIf(!serverUp)("native tool calling — 실서버", () => {
  it(
    "한 턴에 조회 툴 두 개를 부르고 결과로 최종 답까지 간다",
    async () => {
      const { runAgentLoop } = await import("./agent-loop");
      const { useSettingsStore } = await import("../stores/settingsStore");
      useSettingsStore.getState().setToolMode("native");

      const seen: string[] = [];
      let answer = "";
      for await (const ev of runAgentLoop("내 할 일 목록이랑 오늘 일정 같이 보여줘", [])) {
        if (ev.type === "step_done") seen.push(ev.step.tool);
        if (ev.type === "done") answer = ev.answer;
        if (ev.type === "error") throw new Error(ev.message);
      }

      expect(seen).toContain("todo.list");
      expect(seen).toContain("schedule.list");
      // 툴 결과가 실제로 모델에게 돌아갔는지 — 답에 조회된 값이 나와야 한다.
      expect(answer).toMatch(/우유|치과/);
      expect(useSettingsStore.getState().nativeToolsDegraded).toBe(false);
    },
    240_000
  );

  /**
   * json 폴백은 턴당 툴 하나만 부른다. 이 테스트가 확인하는 건 "폴백 경로가 살아
   * 있는가" 다 — 툴이 실제로 돌고 루프가 답까지 도달하는지.
   *
   * 답변 품질은 확인하지 않는다. `--reasoning-format` 이 none 이 아닌 서버에서는
   * grammar 로 강제한 JSON 이 통째로 reasoning_content 로 가고, 모델이 thought 만
   * 채운 채 finalAnswer 를 비우는 일이 잦다. 앱 기본 설정(reasoning_format: "none")
   * 에서는 해당 없다.
   */
  it(
    "json 폴백 모드도 여전히 동작한다 (턴당 툴 하나)",
    async () => {
      const { runAgentLoop } = await import("./agent-loop");
      const { useSettingsStore } = await import("../stores/settingsStore");
      useSettingsStore.getState().setToolMode("json");

      const seen: string[] = [];
      let answer = "";
      for await (const ev of runAgentLoop("내 할 일 목록 보여줘", [])) {
        if (ev.type === "step_done") seen.push(ev.step.tool);
        if (ev.type === "done") answer = ev.answer;
        if (ev.type === "error") throw new Error(ev.message);
      }

      expect(seen).toContain("todo.list");
      expect(answer.trim().length).toBeGreaterThan(0);
    },
    240_000
  );

  it(
    "다단계 요청에는 스스로 계획을 세운다",
    async () => {
      const { runAgentLoop } = await import("./agent-loop");
      const { useSettingsStore } = await import("../stores/settingsStore");
      useSettingsStore.getState().setToolMode("native");

      const planned: string[][] = [];
      for await (const ev of runAgentLoop(
        "할 일 목록을 보고, 오늘 일정도 확인한 다음, 둘을 합쳐서 하루 계획을 정리해줘. " +
          "여러 단계니까 plan.set 으로 계획부터 세워.",
        []
      )) {
        if (ev.type === "plan_updated") planned.push(ev.steps.map((s) => s.text));
        if (ev.type === "error") throw new Error(ev.message);
      }

      expect(planned.length, "계획을 한 번도 안 세웠다").toBeGreaterThan(0);
      expect(planned[0].length).toBeGreaterThan(1);
    },
    240_000
  );
});

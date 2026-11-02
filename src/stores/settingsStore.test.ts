import { it, expect, vi, beforeEach, afterEach } from "vitest";

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

it("기본값으로 시작 (localStorage 비어있을 때)", async () => {
  const { useSettingsStore, DEFAULT_LLM_URL, DEFAULT_GEN_PARAMS } = await import("./settingsStore");
  const s = useSettingsStore.getState();
  expect(s.llmUrl).toBe(DEFAULT_LLM_URL);
  expect(s.genParams).toEqual(DEFAULT_GEN_PARAMS);
  expect(s.systemPrompt).toBeNull();
  expect(s.userProfile).toBeNull();
});

it("setter 가 store + localStorage 둘 다 갱신 (발산 없음)", async () => {
  const { useSettingsStore } = await import("./settingsStore");
  useSettingsStore.getState().setLlmUrl("http://x:9000");
  expect(useSettingsStore.getState().llmUrl).toBe("http://x:9000");
  expect(localStorage.getItem("nekodesk_llm_url")).toBe("http://x:9000");
});

it("null 로 지우면 localStorage 삭제 + store null", async () => {
  const { useSettingsStore } = await import("./settingsStore");
  useSettingsStore.getState().setSystemPrompt("custom");
  expect(localStorage.getItem("nekodesk_system_prompt")).toBe("custom");
  useSettingsStore.getState().setSystemPrompt(null);
  expect(localStorage.getItem("nekodesk_system_prompt")).toBeNull();
  expect(useSettingsStore.getState().systemPrompt).toBeNull();
});

it("init 시 기존 localStorage 값을 읽는다 (마이그레이션 0)", async () => {
  localStorage.setItem("nekodesk_llm_url", "http://saved:1");
  localStorage.setItem("nekodesk_gen_params", JSON.stringify({ max_tokens_agent: 999, max_tokens_chat: 111 }));
  const { useSettingsStore } = await import("./settingsStore");
  expect(useSettingsStore.getState().llmUrl).toBe("http://saved:1");
  expect(useSettingsStore.getState().genParams.max_tokens_agent).toBe(999);
});

it("Claude 로 바꾸면 최대 응답 토큰을 그 모델의 천장(128K) 안으로 맞춘다 — 넘기면 요청이 400", async () => {
  const { useSettingsStore } = await import("./settingsStore");
  const s = () => useSettingsStore.getState();
  s().setGenParams({ max_tokens_agent: 131072, max_tokens_chat: 512 });
  expect(s().genParams.max_tokens_agent).toBe(131072); // 로컬 서버는 천장이 없다
  s().setLlmUrl("claude://claude-haiku-5-5");
  expect(s().genParams).toEqual({ max_tokens_agent: 128_000, max_tokens_chat: 512 });
  expect(JSON.parse(localStorage.getItem("nekodesk_gen_params")!).max_tokens_agent).toBe(128_000);
  // Claude 인 동안엔 고쳐도 천장을 못 넘는다.
  s().setGenParams({ max_tokens_agent: 200_000, max_tokens_chat: 512 });
  expect(s().genParams.max_tokens_agent).toBe(128_000);
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * dev 에서는 StrictMode 가 마운트 이펙트를 두 번, Fast Refresh 가 App.tsx 를 고칠
 * 때마다 한 번 더 실행한다. 부트스트랩이 그때마다 llama_start 를 부르면 떠 있는
 * 서버가 죽고 모델이 처음부터 다시 올라간다. 서버를 한 번만 띄우는지 확인한다.
 */

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  initMcp: vi.fn(),
  waitReady: vi.fn(),
  warmUp: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../agent/mcp-registry", () => ({ initMcpFromStorage: mocks.initMcp }));
vi.mock("../agent/llm-client", () => ({
  waitForLlmReady: mocks.waitReady,
  warmUpModel: mocks.warmUp,
}));

let store: Map<string, string>;

function enableAutostart() {
  store.set("nekodesk_llama_autostart", "true");
  store.set("nekodesk_llama_config", JSON.stringify({ model: "Qwen3.5-4B-Q4_K_M.gguf" }));
}

function callsTo(command: string) {
  return mocks.invoke.mock.calls.filter(([name]) => name === command).length;
}

/** bootstrap 은 fire-and-forget 이라 내부 await 가 다 풀릴 때까지 기다린다. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  mocks.invoke.mockImplementation(async (command: string) =>
    command === "llama_is_running" ? false : undefined
  );
  mocks.initMcp.mockResolvedValue(undefined);
  mocks.waitReady.mockResolvedValue(true);
  mocks.warmUp.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("bootstrapOnce", () => {
  it("여러 번 불려도 서버는 한 번만 띄우고 한 번만 데운다", async () => {
    enableAutostart();
    const { bootstrapOnce } = await import("./llama-bootstrap");

    bootstrapOnce();
    bootstrapOnce(); // StrictMode 두 번째 실행
    bootstrapOnce(); // Fast Refresh
    await settle();

    expect(callsTo("llama_start")).toBe(1);
    expect(mocks.initMcp).toHaveBeenCalledTimes(1);
    expect(mocks.warmUp).toHaveBeenCalledTimes(1);
  });

  it("서버가 이미 떠 있으면 재기동하지 않고 워밍업만 한다", async () => {
    enableAutostart();
    mocks.invoke.mockImplementation(async (command: string) =>
      command === "llama_is_running" ? true : undefined
    );
    const { bootstrapOnce } = await import("./llama-bootstrap");

    bootstrapOnce();
    await settle();

    expect(callsTo("llama_start")).toBe(0);
    expect(mocks.warmUp).toHaveBeenCalledTimes(1);
  });

  it("MCP 로드가 끝난 뒤에 워밍업한다 (시스템 프롬프트에 MCP 도구 목록이 들어간다)", async () => {
    enableAutostart();
    let finishMcp!: () => void;
    mocks.initMcp.mockReturnValue(new Promise<void>((resolve) => { finishMcp = resolve; }));
    const { bootstrapOnce } = await import("./llama-bootstrap");

    bootstrapOnce();
    await settle();
    expect(mocks.warmUp).not.toHaveBeenCalled();

    finishMcp();
    await settle();
    expect(mocks.warmUp).toHaveBeenCalledTimes(1);
  });

  it("autostart 가 꺼져 있으면 서버를 건드리지 않고 MCP 만 로드한다", async () => {
    const { bootstrapOnce } = await import("./llama-bootstrap");

    bootstrapOnce();
    await settle();

    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(mocks.initMcp).toHaveBeenCalledTimes(1);
    expect(mocks.warmUp).not.toHaveBeenCalled();
  });

  it("기동에 실패하면 워밍업하지 않는다", async () => {
    enableAutostart();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "llama_is_running") return false;
      throw new Error("llama-server 바이너리를 찾을 수 없습니다");
    });
    const { bootstrapOnce } = await import("./llama-bootstrap");

    bootstrapOnce();
    await settle();

    expect(mocks.warmUp).not.toHaveBeenCalled();
  });

  it("모델 로딩이 끝나지 않으면 워밍업하지 않는다", async () => {
    enableAutostart();
    mocks.waitReady.mockResolvedValue(false);
    const { bootstrapOnce } = await import("./llama-bootstrap");

    bootstrapOnce();
    await settle();

    expect(mocks.warmUp).not.toHaveBeenCalled();
  });
});

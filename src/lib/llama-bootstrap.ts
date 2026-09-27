import { invoke } from "@tauri-apps/api/core";
import { initMcpFromStorage } from "../agent/mcp-registry";
import { waitForLlmReady, warmUpModel } from "../agent/llm-client";

/**
 * 앱 시작 시 한 번만 도는 준비 작업:
 * MCP 도구 로드 → (autostart 면) llama-server 기동 → 로딩 대기 → 에이전트 프롬프트 워밍업.
 *
 * App 컴포넌트 밖 모듈에서 한 번만 돌게 막는 이유:
 * - dev 의 StrictMode 는 마운트 이펙트를 두 번 실행하고,
 * - Fast Refresh 는 App.tsx 를 고칠 때마다 deps 가 빈 이펙트도 다시 실행한다.
 * 예전엔 그때마다 llama_start 가 떠 있는 서버를 죽이고 모델을 처음부터 다시 올렸다
 * (프롬프트 캐시도 함께 날아가 다음 질문이 다시 cold 가 된다).
 * 이 모듈은 App.tsx 를 고쳐도 다시 평가되지 않으므로 플래그가 유지된다.
 */
let started = false;

export function bootstrapOnce(): void {
  if (started) return;
  started = true;
  void bootstrap();
}

async function bootstrap(): Promise<void> {
  // 에이전트 시스템 프롬프트에 MCP 도구 목록이 들어간다. 워밍업은 로드가 끝난 뒤여야
  // 실제 요청과 프롬프트가 같아져 캐시가 맞는다.
  const mcpReady = initMcpFromStorage().catch(() => {});

  const config = readAutostartConfig();
  if (!config) return;

  try {
    // 웹뷰만 새로고침된 경우(dev 의 전체 리로드 등) Rust 쪽 서버는 살아 있다.
    // 다시 띄우면 모델 재로딩 + 캐시 유실이므로 그대로 쓴다.
    const running = await invoke<boolean>("llama_is_running").catch(() => false);
    if (!running) await invoke("llama_start", { config });
  } catch {
    return; // 실패 시 무시 — 설정 페이지에서 수동 실행 가능
  }

  await mcpReady;
  if (await waitForLlmReady()) await warmUpModel();
}

function readAutostartConfig(): Record<string, unknown> | null {
  if (localStorage.getItem("nekodesk_llama_autostart") !== "true") return null;
  const raw = localStorage.getItem("nekodesk_llama_config");
  if (!raw) return null;
  try {
    const config = JSON.parse(raw) as Record<string, unknown>;
    return config.model ? config : null;
  } catch {
    return null; // config 파싱 실패 시 무시
  }
}

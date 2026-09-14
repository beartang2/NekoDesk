/**
 * 모델 프로필 — "한 번 설정해두고, 목록에서 한 번 눌러 연결한다".
 *
 * 예전엔 설정이 두 군데로 흩어져 있었다. `nekodesk_llm_url`(어디로 요청할지)과
 * `nekodesk_llama_config`(로컬 서버를 어떻게 띄울지). 둘 다 하나씩뿐이라 모델을
 * 바꾸려면 양쪽을 손으로 맞춰야 했고, 외부에 떠 있는 다른 로컬 모델을 쓰려면
 * llama 설정과 URL 이 서로 어긋난 채 남았다.
 *
 * 프로필 하나가 그 둘을 묶는다:
 *  - `config` 가 있으면 **관리형** — 앱이 llama-server 를 직접 띄우고, 주소는
 *    host:port 에서 파생한다.
 *  - `config` 가 null 이면 **외부** — 이미 떠 있는 OpenAI 호환 서버에 붙기만 한다
 *    (다른 맥에 띄운 llama.cpp, Ollama, LM Studio 등).
 */

import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore, DEFAULT_LLM_URL } from "./settingsStore";

export interface LlamaConfig {
  model: string;
  mmproj: string;
  model_draft: string;
  ngl: number;
  flash_attn: boolean;
  jinja: boolean;
  ctk: string;
  ctv: string;
  context: number;
  temp: number;
  top_k: number;
  top_p: number;
  min_p: number;
  port: number;
  host: string;
  reasoning: string;
  reasoning_format: string;
  mtp_n_draft: number;
}

export const DEFAULT_LLAMA_CONFIG: LlamaConfig = {
  model: "",
  mmproj: "",
  model_draft: "",
  ngl: 99,
  flash_attn: true,
  jinja: true,
  ctk: "q4_0",
  ctv: "q4_0",
  context: 8192,
  temp: 1.0,
  top_k: 64,
  top_p: 0.95,
  min_p: 0.0,
  port: 8803,
  host: "127.0.0.1",
  reasoning: "off",
  reasoning_format: "none",
  mtp_n_draft: 0,
};

export interface ModelProfile {
  id: string;
  name: string;
  /** 외부 프로필의 엔드포인트. 관리형은 config.host:port 에서 파생하므로 비어 있다. */
  url: string;
  /** 관리형이면 llama-server 실행 인자, 외부면 null. */
  config: LlamaConfig | null;
}

export interface ProfileState {
  profiles: ModelProfile[];
  activeId: string;
}

const KEY = "nekodesk_model_profiles";
const LEGACY_CONFIG_KEY = "nekodesk_llama_config";
const LEGACY_URL_KEY = "nekodesk_llm_url";

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** 프로필이 가리키는 주소. 관리형은 실행 설정이 곧 주소다. */
export function profileUrl(p: ModelProfile): string {
  if (!p.config) return p.url.trim() || DEFAULT_LLM_URL;
  // llama-server 를 0.0.0.0 에 띄웠더라도 앱이 붙는 건 언제나 루프백이다.
  const host = p.config.host === "0.0.0.0" ? "127.0.0.1" : p.config.host;
  return `http://${host}:${p.config.port}`;
}

export function modelLabel(p: ModelProfile): string {
  if (!p.config) return p.url.trim() || "(주소 없음)";
  return p.config.model ? (p.config.model.split("/").pop() ?? "") : "(모델 미선택)";
}

function sanitize(c: Partial<LlamaConfig>): LlamaConfig {
  const merged = { ...DEFAULT_LLAMA_CONFIG, ...c };
  // 0.0.0.0 은 llama-server 를 모든 네트워크 인터페이스에 연다. 같은 와이파이의
  // 누구나 인증 없이 모델을 쓸 수 있다는 뜻이고, 앱 자신은 루프백으로만 붙으므로
  // 얻는 것도 없다. 저장된 값도 되돌린다 — 정말 LAN 에 열고 싶으면 다시 입력하면 된다.
  if (merged.host === "0.0.0.0") merged.host = "127.0.0.1";
  return merged;
}

/**
 * 예전 단일 설정을 프로필 하나로 옮긴다.
 *
 * 이미 쓰던 로컬 모델이 그대로 기본 프로필이 되는 게 요점이다 — 업그레이드 후
 * 아무것도 다시 고르지 않아도 어제와 똑같이 뜬다. 앱으로 서버를 띄운 적이
 * 없다면(모델 미선택) 손으로 띄워둔 서버를 외부 프로필로 받아 적는다.
 */
function migrate(): ProfileState {
  const url = localStorage.getItem(LEGACY_URL_KEY)?.trim() || DEFAULT_LLM_URL;
  let config: LlamaConfig | null = null;
  try {
    const raw = localStorage.getItem(LEGACY_CONFIG_KEY);
    if (raw) {
      const parsed = sanitize(JSON.parse(raw) as Partial<LlamaConfig>);
      if (parsed.model) config = parsed;
    }
  } catch { /* 깨진 설정은 없는 셈 친다 */ }

  const profiles: ModelProfile[] = [];
  if (config) {
    profiles.push({ id: newId(), name: config.model.split("/").pop()?.replace(/\.gguf$/i, "") ?? "로컬 모델", url: "", config });
  }
  // 관리형 프로필의 주소와 다른 곳을 보고 있었다면 그쪽도 프로필로 남긴다.
  const managedUrl = profiles[0] ? profileUrl(profiles[0]) : null;
  if (!managedUrl || managedUrl !== url) {
    profiles.push({ id: newId(), name: "외부 서버", url, config: null });
  }
  // 마지막으로 실제 쓰던 주소를 활성으로.
  const active = profiles.find((p) => profileUrl(p) === url) ?? profiles[0];
  return { profiles, activeId: active.id };
}

export function loadProfiles(): ProfileState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ProfileState;
      if (Array.isArray(parsed.profiles) && parsed.profiles.length) {
        const profiles = parsed.profiles.map((p) => ({
          ...p,
          config: p.config ? sanitize(p.config) : null,
        }));
        const activeId = profiles.some((p) => p.id === parsed.activeId) ? parsed.activeId : profiles[0].id;
        return { profiles, activeId };
      }
    }
  } catch { /* 깨졌으면 마이그레이션으로 다시 만든다 */ }
  const migrated = migrate();
  saveProfiles(migrated);
  return migrated;
}

export function saveProfiles(state: ProfileState): void {
  localStorage.setItem(KEY, JSON.stringify(state));
  // 에이전트는 여전히 settingsStore.llmUrl 로 요청한다 — 활성 프로필을 거기에 반영.
  const active = state.profiles.find((p) => p.id === state.activeId);
  if (active) useSettingsStore.getState().setLlmUrl(profileUrl(active));
}

/**
 * 살아 있으면 서버가 물고 있는 모델 이름, 아니면 null.
 *
 * `/v1/models` 는 OpenAI 호환이면 무엇이든(llama.cpp·Ollama·LM Studio) 답한다.
 * 생사 확인과 "무엇이 떠 있는가" 를 한 번에 하려고 id 까지 돌려준다 — 같은 포트를
 * 쓰는 프로필끼리 전환할 때 이게 없으면 이전 모델에 그대로 붙는다.
 */
export async function probe(url: string, timeoutMs = 2000): Promise<string | null> {
  try {
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const data = await res.json() as { data?: Array<{ id?: string }> };
    return data.data?.[0]?.id ?? "";
  } catch {
    return null;
  }
}

function basename(p: string): string {
  return p.split("/").pop() ?? p;
}

/**
 * 프로필 한 번 클릭 = 연결.
 *
 * 외부는 주소만 바꾸면 끝이고, 관리형은 이미 그 설정으로 떠 있지 않은 한
 * llama-server 를 띄운다(`llama_start` 가 기존 서버와 포트 점유자를 먼저 정리하므로
 * 모델 전환도 이 한 번의 호출로 끝난다).
 */
export async function activateProfile(p: ModelProfile, prev?: ModelProfile | null): Promise<void> {
  const url = profileUrl(p);
  useSettingsStore.getState().setLlmUrl(url);

  // 떠나온 프로필이 앱이 띄운 서버였다면 내려놓는다. 로컬 모델은 VRAM 을 통째로
  // 물고 있어서, 남겨두면 쓰지도 않는 모델이 새로 띄울 모델과 메모리를 다툰다.
  // 같은 포트의 관리형으로 옮겨가는 경우는 건너뛴다 — `llama_start` 가 어차피
  // 기존 서버를 먼저 정리하므로, 여기서 또 죽이면 왕복만 한 번 더 는다.
  if (prev?.config && prev.id !== p.id && prev.config.port !== p.config?.port) {
    await invoke("llama_stop", { port: prev.config.port })
      .catch((e) => console.warn("이전 프로필 서버 중지 실패:", e));
  }

  if (!p.config) return;
  if (!p.config.model) throw new Error("모델이 선택되지 않은 프로필입니다.");
  const running = await probe(url, 1500);
  // 같은 모델이 이미 그 주소에 떠 있으면 그대로 쓴다. 다른 모델이면 갈아탄다
  // (llama.cpp 는 id 로 모델 경로를 주지만, alias 를 준 서버도 있어 basename 으로 비교).
  if (running !== null && running !== "" && basename(running) === basename(p.config.model)) return;
  await invoke("llama_start", { config: p.config });
}

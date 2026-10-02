import { create } from "zustand";

/**
 * LLM 관련 설정 스토어 (llm_url / gen_params / system_prompt / user_profile).
 *
 * 예전엔 llm-client 가 hot path 에서 localStorage 를 직접 읽고(getLlmUrl,
 * loadGenParams, profile, systemPrompt) SettingsModal 이 각자 useState + localStorage
 * 로 써서 흩어져 있었다. 단일 스토어로 모은다.
 *
 * localStorage 키/포맷은 기존 그대로 → 마이그레이션 0. 순환참조를 피하려 기본값을
 * 여기서 자체 정의한다(llm-client 를 import 하지 않음). system_prompt/user_profile 은
 * 미설정 시 null 로 두고, 읽는 쪽(llm-client)이 자기 기본값을 적용한다.
 */

export const DEFAULT_LLM_URL = "http://127.0.0.1:8803";

export interface GenParams {
  max_tokens_agent: number;
  max_tokens_chat: number;
}
export const DEFAULT_GEN_PARAMS: GenParams = {
  max_tokens_agent: 2048,
  max_tokens_chat: 512,
};

/**
 * 툴 호출 방식.
 *  - native: 서버의 `tools` 파라미터 (한 턴에 여러 툴, 파싱은 서버가 담당)
 *  - json:   GBNF grammar 로 JSON 한 덩이를 강제하는 예전 방식 (턴당 툴 1개)
 *  - auto:   native 로 시도하고, 서버가 거부하면 이 세션 동안 json 으로 강등
 *
 * `--jinja` 없이 뜬 llama-server 나 툴 템플릿이 없는 모델은 `tools` 를 거부한다.
 * auto 가 기본이라 사용자가 서버 옵션을 몰라도 동작한다.
 */
export type ToolMode = "auto" | "native" | "json";
export const DEFAULT_TOOL_MODE: ToolMode = "auto";

/** 그림 그리기 서비스. 키는 비밀이라 여기 말고 DB settings 에 둔다(백엔드가 읽는다). */
export type ImageProvider = "off" | "cloudflare" | "google";
export interface ImageGenSettings {
  provider: ImageProvider;
  cfModel: string;
  googleModel: string;
}
export const DEFAULT_IMAGE_GEN: ImageGenSettings = {
  provider: "off",
  cfModel: "@cf/black-forest-labs/flux-1-schnell",
  googleModel: "gemini-3.1-flash-image",
};

const K = {
  llmUrl: "nekodesk_llm_url",
  genParams: "nekodesk_gen_params",
  systemPrompt: "nekodesk_system_prompt",
  userProfile: "nekodesk_user_profile",
  toolMode: "nekodesk_tool_mode",
  imageGen: "nekodesk_image_gen",
} as const;

function loadToolMode(): ToolMode {
  const raw = localStorage.getItem(K.toolMode);
  return raw === "native" || raw === "json" || raw === "auto" ? raw : DEFAULT_TOOL_MODE;
}

function loadImageGen(): ImageGenSettings {
  try {
    const raw = localStorage.getItem(K.imageGen);
    return raw ? { ...DEFAULT_IMAGE_GEN, ...JSON.parse(raw) } : { ...DEFAULT_IMAGE_GEN };
  } catch {
    return { ...DEFAULT_IMAGE_GEN };
  }
}

function loadGen(): GenParams {
  try {
    const raw = localStorage.getItem(K.genParams);
    return raw ? { ...DEFAULT_GEN_PARAMS, ...JSON.parse(raw) } : { ...DEFAULT_GEN_PARAMS };
  } catch {
    return { ...DEFAULT_GEN_PARAMS };
  }
}

interface SettingsStore {
  llmUrl: string;
  genParams: GenParams;
  systemPrompt: string | null; // null = 읽는 쪽 기본값 사용
  userProfile: string | null;
  toolMode: ToolMode;
  imageGen: ImageGenSettings;
  /** auto 모드에서 서버가 `tools` 를 거부해 json 으로 내려앉았다. 영속화하지 않는다. */
  nativeToolsDegraded: boolean;
  setLlmUrl: (url: string) => void;
  setGenParams: (p: GenParams) => void;
  /** null 이면 삭제(기본값으로 복귀). */
  setSystemPrompt: (v: string | null) => void;
  setUserProfile: (v: string | null) => void;
  setToolMode: (m: ToolMode) => void;
  setImageGen: (p: ImageGenSettings) => void;
  setNativeToolsDegraded: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  llmUrl: localStorage.getItem(K.llmUrl) ?? DEFAULT_LLM_URL,
  genParams: loadGen(),
  systemPrompt: localStorage.getItem(K.systemPrompt),
  userProfile: localStorage.getItem(K.userProfile),
  toolMode: loadToolMode(),
  imageGen: loadImageGen(),
  nativeToolsDegraded: false,

  setLlmUrl: (url) => {
    localStorage.setItem(K.llmUrl, url);
    set({ llmUrl: url });
  },
  setGenParams: (p) => {
    localStorage.setItem(K.genParams, JSON.stringify(p));
    set({ genParams: p });
  },
  setSystemPrompt: (v) => {
    if (v === null) localStorage.removeItem(K.systemPrompt);
    else localStorage.setItem(K.systemPrompt, v);
    set({ systemPrompt: v });
  },
  setUserProfile: (v) => {
    if (v === null) localStorage.removeItem(K.userProfile);
    else localStorage.setItem(K.userProfile, v);
    set({ userProfile: v });
  },
  setToolMode: (m) => {
    localStorage.setItem(K.toolMode, m);
    // 사용자가 직접 모드를 고르면 이전 강등 기록은 무효 — 새 설정으로 다시 시도한다.
    set({ toolMode: m, nativeToolsDegraded: false });
  },
  setImageGen: (p) => {
    localStorage.setItem(K.imageGen, JSON.stringify(p));
    set({ imageGen: p });
  },
  setNativeToolsDegraded: (v) => set({ nativeToolsDegraded: v }),
}));

/** 이번 호출에 native tool calling 을 쓸 것인가. */
export function shouldUseNativeTools(): boolean {
  const { toolMode, nativeToolsDegraded } = useSettingsStore.getState();
  if (toolMode === "json") return false;
  if (toolMode === "native") return true;
  return !nativeToolsDegraded;
}

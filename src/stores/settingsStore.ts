import { create } from "zustand";
import { claudeContextCap, isClaudeUrl, maxOutputTokensFor } from "../lib/claude-models";

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
  weatherLocation: "nekodesk_weather_location",
  claudeContext: "nekodesk_claude_context",
} as const;

function loadClaudeContext(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(K.claudeContext) ?? "{}") as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, number>) : {};
  } catch {
    return {};
  }
}

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

/**
 * 지금 주소가 받는 천장 안으로 맞춘다. 설정의 최대 응답 토큰은 프로필마다 따로가 아니라
 * 하나라서, 로컬에서 131072 로 쓰다가 Claude(128K)로 바꾸면 그대로 400 이 난다. 프로필을
 * 바꿀 때와 값을 고칠 때 둘 다 여기를 지나므로 천장을 넘는 값은 아예 저장되지 않는다.
 */
export function fitGenParams(p: GenParams, url: string): GenParams {
  const cap = maxOutputTokensFor(url);
  if (cap === null || (p.max_tokens_agent <= cap && p.max_tokens_chat <= cap)) return p;
  return { max_tokens_agent: Math.min(p.max_tokens_agent, cap), max_tokens_chat: Math.min(p.max_tokens_chat, cap) };
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
  /** 고양이 옆에 띄울 날씨의 지역. 빈 문자열이면 숨긴다. */
  weatherLocation: string;
  /** Claude 모델별로 고른 컨텍스트 길이(모델 id → 토큰). 없으면 모델 기본값. */
  claudeContext: Record<string, number>;
  /** auto 모드에서 서버가 `tools` 를 거부해 json 으로 내려앉았다. 영속화하지 않는다. */
  nativeToolsDegraded: boolean;
  setLlmUrl: (url: string) => void;
  setGenParams: (p: GenParams) => void;
  /** null 이면 삭제(기본값으로 복귀). */
  setSystemPrompt: (v: string | null) => void;
  setUserProfile: (v: string | null) => void;
  setToolMode: (m: ToolMode) => void;
  setImageGen: (p: ImageGenSettings) => void;
  setWeatherLocation: (v: string) => void;
  setClaudeContext: (model: string, tokens: number) => void;
  setNativeToolsDegraded: (v: boolean) => void;
}

const initialUrl = localStorage.getItem(K.llmUrl) ?? DEFAULT_LLM_URL;

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  llmUrl: initialUrl,
  genParams: fitGenParams(loadGen(), initialUrl),
  systemPrompt: localStorage.getItem(K.systemPrompt),
  userProfile: localStorage.getItem(K.userProfile),
  toolMode: loadToolMode(),
  imageGen: loadImageGen(),
  weatherLocation: localStorage.getItem(K.weatherLocation) ?? "Seoul",
  claudeContext: loadClaudeContext(),
  nativeToolsDegraded: false,

  setLlmUrl: (url) => {
    localStorage.setItem(K.llmUrl, url);
    const genParams = fitGenParams(get().genParams, url);
    if (genParams !== get().genParams) localStorage.setItem(K.genParams, JSON.stringify(genParams));
    set({ llmUrl: url, genParams });
  },
  setGenParams: (p) => {
    const genParams = fitGenParams(p, get().llmUrl);
    localStorage.setItem(K.genParams, JSON.stringify(genParams));
    set({ genParams });
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
  setWeatherLocation: (v) => {
    localStorage.setItem(K.weatherLocation, v);
    set({ weatherLocation: v });
  },
  setClaudeContext: (model, tokens) => {
    const claudeContext = { ...get().claudeContext, [model]: tokens };
    localStorage.setItem(K.claudeContext, JSON.stringify(claudeContext));
    set({ claudeContext });
  },
  setNativeToolsDegraded: (v) => set({ nativeToolsDegraded: v }),
}));

/** 그 Claude 모델로 쓸 컨텍스트 길이(설정에서 고른 값, 없으면 기본값). */
export function claudeContextFor(model: string): number {
  return claudeContextCap(model, useSettingsStore.getState().claudeContext[model]);
}

/** 이번 호출에 native tool calling 을 쓸 것인가. */
/** 지금 Claude 프로필로 묻고 있는가. 큰 모델에게만 주는 것(원칙 규칙·그림 확인·스킬 본문)을 가를 때 본다. */
export function isClaudeActive(): boolean {
  return isClaudeUrl(useSettingsStore.getState().llmUrl);
}

export function shouldUseNativeTools(): boolean {
  const { toolMode, nativeToolsDegraded, llmUrl } = useSettingsStore.getState();
  // json 모드는 llama.cpp 의 GBNF grammar 로 출력을 묶는 방식이라 Claude 에선 성립하지 않는다.
  // Claude 는 툴 호출을 기본으로 지원하므로 설정과 무관하게 native 로 간다.
  if (isClaudeUrl(llmUrl)) return true;
  if (toolMode === "json") return false;
  if (toolMode === "native") return true;
  return !nativeToolsDegraded;
}

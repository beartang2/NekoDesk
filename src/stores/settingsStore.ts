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

const K = {
  llmUrl: "nekodesk_llm_url",
  genParams: "nekodesk_gen_params",
  systemPrompt: "nekodesk_system_prompt",
  userProfile: "nekodesk_user_profile",
  fastDecision: "nekodesk_fast_decision",
} as const;

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
  /** 생각 없이 확률로 도구를 고른다(확신이 낮으면 생각하는 방식으로 다시). 기본 켜짐. */
  fastDecision: boolean;
  setLlmUrl: (url: string) => void;
  setFastDecision: (v: boolean) => void;
  setGenParams: (p: GenParams) => void;
  /** null 이면 삭제(기본값으로 복귀). */
  setSystemPrompt: (v: string | null) => void;
  setUserProfile: (v: string | null) => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  llmUrl: localStorage.getItem(K.llmUrl) ?? DEFAULT_LLM_URL,
  genParams: loadGen(),
  systemPrompt: localStorage.getItem(K.systemPrompt),
  userProfile: localStorage.getItem(K.userProfile),
  fastDecision: localStorage.getItem(K.fastDecision) !== "false",

  setLlmUrl: (url) => {
    localStorage.setItem(K.llmUrl, url);
    set({ llmUrl: url });
  },
  setFastDecision: (v) => {
    localStorage.setItem(K.fastDecision, String(v));
    set({ fastDecision: v });
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
}));

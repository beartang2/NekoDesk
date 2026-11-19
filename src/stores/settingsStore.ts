import { create } from "zustand";
import { settingsApi } from "../api/tauri";
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
  nekoName: "nekodesk_neko_name",
  userProfile: "nekodesk_user_profile",
  toolMode: "nekodesk_tool_mode",
  imageGen: "nekodesk_image_gen",
  weatherLocation: "nekodesk_weather_location",
  claudeContext: "nekodesk_claude_context",
  autoCompact: "nekodesk_auto_compact",
  sessionRetention: "nekodesk_session_retention",
  memoryTidy: "nekodesk_memory_tidy",
  nekoWallpaper: "nekodesk_neko_wallpaper",
} as const;

/**
 * 다른 기기와 같이 쓰는 설정(docs/neko-sync.md §2.2). localStorage 는 켤 때 바로 쓰는 캐시로 두고, 바꿀 때 settings DB
 * 에도 적는다 — 동기화는 DB 를 본다. 켤 때·다른 기기에서 바뀌었을 때 hydrateSyncedSettings 가 DB 값으로 덮는다.
 * DB 키 목록은 Rust db::SYNCED_SETTINGS 와 같아야 한다. 빈 글은 없음(null)이다.
 */
const SYNCED = {
  nekoName: "neko_name",
  systemPrompt: "neko_persona",
  userProfile: "user_profile",
  sessionRetention: "session_retention",
} as const;
type SyncedField = keyof typeof SYNCED;
const mirror = (field: SyncedField, value: string | null) => void settingsApi.set(SYNCED[field], value ?? "").catch(() => {});

/** 오래된 대화를 지우는 기준(일). 0 이면 끔 */
export type SessionRetention = 0 | 30 | 90;
/** 방·거실 벽지(neko/Wallpaper.tsx). 이 기기에만 */
export type NekoWallpaper = "plain" | "panel" | "twotone" | "arch";
const WALLPAPERS: readonly NekoWallpaper[] = ["plain", "panel", "twotone", "arch"];
const toRetention = (raw: string | null): SessionRetention => (raw === "0" ? 0 : raw === "90" ? 90 : 30);
function loadSessionRetention(): SessionRetention {
  return toRetention(localStorage.getItem(K.sessionRetention));
}

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
  /** 사용자가 지어 준 이름. 입력창 그대로라 비어 있을 수 있다 — 쓸 땐 nekoNameOf. */
  nekoName: string;
  userProfile: string | null;
  toolMode: ToolMode;
  imageGen: ImageGenSettings;
  /** 고양이 옆에 띄울 날씨의 지역. 빈 문자열이면 숨긴다. */
  weatherLocation: string;
  /** Claude 모델별로 고른 컨텍스트 길이(모델 id → 토큰). 없으면 모델 기본값. */
  claudeContext: Record<string, number>;
  /** 대화가 예산에 차 가면 앞 대화를 혼자 요약한다(useAgentLoop.autoCompact). */
  autoCompact: boolean;
  /** 마지막으로 쓴 지 이만큼(일) 지난 대화를 켤 때 지운다(sessionStore.pruneOldSessions). 0 이면 끔 */
  sessionRetention: SessionRetention;
  /** 네코가 졸 때 하루 한 번 겹치는 기억을 합친다(neko/memoryTidy.ts). Claude 프로필일 때만 돈다 */
  memoryTidy: boolean;
  nekoWallpaper: NekoWallpaper;
  /** auto 모드에서 서버가 `tools` 를 거부해 json 으로 내려앉았다. 영속화하지 않는다. */
  nativeToolsDegraded: boolean;
  setLlmUrl: (url: string) => void;
  setGenParams: (p: GenParams) => void;
  /** null 이면 삭제(기본값으로 복귀). */
  setSystemPrompt: (v: string | null) => void;
  setNekoName: (v: string) => void;
  setUserProfile: (v: string | null) => void;
  setToolMode: (m: ToolMode) => void;
  setImageGen: (p: ImageGenSettings) => void;
  setWeatherLocation: (v: string) => void;
  setClaudeContext: (model: string, tokens: number) => void;
  setAutoCompact: (on: boolean) => void;
  setSessionRetention: (days: SessionRetention) => void;
  setMemoryTidy: (on: boolean) => void;
  setNekoWallpaper: (v: NekoWallpaper) => void;
  setNativeToolsDegraded: (v: boolean) => void;
}

const initialUrl = localStorage.getItem(K.llmUrl) ?? DEFAULT_LLM_URL;

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  llmUrl: initialUrl,
  genParams: fitGenParams(loadGen(), initialUrl),
  systemPrompt: localStorage.getItem(K.systemPrompt),
  nekoName: localStorage.getItem(K.nekoName) ?? "",
  userProfile: localStorage.getItem(K.userProfile),
  toolMode: loadToolMode(),
  imageGen: loadImageGen(),
  weatherLocation: localStorage.getItem(K.weatherLocation) ?? "Seoul",
  nekoWallpaper: WALLPAPERS.find((v) => v === localStorage.getItem(K.nekoWallpaper)) ?? "plain",
  claudeContext: loadClaudeContext(),
  autoCompact: localStorage.getItem(K.autoCompact) !== "off",
  sessionRetention: loadSessionRetention(),
  memoryTidy: localStorage.getItem(K.memoryTidy) !== "off",
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
    mirror("systemPrompt", v);
  },
  setNekoName: (v) => {
    localStorage.setItem(K.nekoName, v);
    set({ nekoName: v });
    mirror("nekoName", v);
  },
  setUserProfile: (v) => {
    if (v === null) localStorage.removeItem(K.userProfile);
    else localStorage.setItem(K.userProfile, v);
    set({ userProfile: v });
    mirror("userProfile", v);
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
  setNekoWallpaper: (v) => {
    localStorage.setItem(K.nekoWallpaper, v);
    set({ nekoWallpaper: v });
  },
  setClaudeContext: (model, tokens) => {
    const claudeContext = { ...get().claudeContext, [model]: tokens };
    localStorage.setItem(K.claudeContext, JSON.stringify(claudeContext));
    set({ claudeContext });
  },
  setAutoCompact: (on) => {
    localStorage.setItem(K.autoCompact, on ? "on" : "off");
    set({ autoCompact: on });
  },
  setSessionRetention: (days) => {
    localStorage.setItem(K.sessionRetention, String(days));
    set({ sessionRetention: days });
    mirror("sessionRetention", String(days));
  },
  setMemoryTidy: (on) => {
    localStorage.setItem(K.memoryTidy, on ? "on" : "off");
    set({ memoryTidy: on });
  },
  setNativeToolsDegraded: (v) => set({ nativeToolsDegraded: v }),
}));

/**
 * 같이 쓰는 설정을 DB 값으로 덮는다(DB 에 다시 적지 않는다). DB 에 없으면(처음) 사용자가 정해 둔 localStorage 값을
 * 옮긴다 — 정한 적 없는 기본값은 안 옮겨서, 새로 짝 맞춘 기기가 다른 기기의 값을 기본값으로 덮지 않는다.
 */
export async function hydrateSyncedSettings(): Promise<void> {
  for (const field of Object.keys(SYNCED) as SyncedField[]) {
    const v = await settingsApi.get(SYNCED[field]).catch(() => undefined);
    if (v === undefined) continue;
    const local = localStorage.getItem(K[field]);
    if (v === null) {
      if (local !== null) mirror(field, local);
      continue;
    }
    if (field === "sessionRetention") {
      localStorage.setItem(K[field], String(toRetention(v)));
      useSettingsStore.setState({ sessionRetention: toRetention(v) });
    } else if (field === "nekoName") {
      localStorage.setItem(K[field], v);
      useSettingsStore.setState({ nekoName: v });
    } else {
      if (v) localStorage.setItem(K[field], v);
      else localStorage.removeItem(K[field]);
      useSettingsStore.setState({ [field]: v || null });
    }
  }
}

export const DEFAULT_NEKO_NAME = "네코";

/** 화면·프롬프트에 쓸 이름. 비었거나 공백뿐이면 "네코". 컴포넌트는 useSettingsStore(nekoNameOf). */
export const nekoNameOf = (s: { nekoName: string }) => s.nekoName.trim() || DEFAULT_NEKO_NAME;

/** 다른 창(빠른 질문)은 스토어를 따로 가진다. 창이 뜰 때 메인 창이 바꾼 이름을 다시 읽는다. */
export const reloadNekoName = () => useSettingsStore.setState({ nekoName: localStorage.getItem(K.nekoName) ?? "" });

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

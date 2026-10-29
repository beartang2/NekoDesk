import { create } from "zustand";
import { claudeModelOf, isClaudeUrl } from "../lib/claude-models";

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
  /** 고양이 옆에 띄울 날씨의 지역. 빈 문자열이면 숨긴다. */
  weatherLocation: string;
  /** auto 모드에서 서버가 `tools` 를 거부해 json 으로 내려앉았다. 영속화하지 않는다. */
  nativeToolsDegraded: boolean;
  /** 서버 툴 능력표가 바뀔 때마다 1 씩. 구독자가 툴 목록을 다시 그리게 한다. */
  serverCapsVersion: number;
  setLlmUrl: (url: string) => void;
  setGenParams: (p: GenParams) => void;
  /** null 이면 삭제(기본값으로 복귀). */
  setSystemPrompt: (v: string | null) => void;
  setUserProfile: (v: string | null) => void;
  setToolMode: (m: ToolMode) => void;
  setImageGen: (p: ImageGenSettings) => void;
  setWeatherLocation: (v: string) => void;
  setNativeToolsDegraded: (v: boolean) => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  llmUrl: localStorage.getItem(K.llmUrl) ?? DEFAULT_LLM_URL,
  genParams: loadGen(),
  systemPrompt: localStorage.getItem(K.systemPrompt),
  userProfile: localStorage.getItem(K.userProfile),
  toolMode: loadToolMode(),
  imageGen: loadImageGen(),
  weatherLocation: localStorage.getItem(K.weatherLocation) ?? "Seoul",
  nativeToolsDegraded: false,
  serverCapsVersion: 0,

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
  setWeatherLocation: (v) => {
    localStorage.setItem(K.weatherLocation, v);
    set({ weatherLocation: v });
  },
  setNativeToolsDegraded: (v) => set({ nativeToolsDegraded: v }),
}));

/**
 * 지금 어느 두뇌에 묻고 있는가.
 *
 *  - local:  llama-server(관리형·외부). 작은 모델용 프롬프트·grammar·휴리스틱 세트.
 *  - claude: Anthropic API. Claude 용 프롬프트 세트, native 툴 고정, grammar 없음.
 *
 * 프롬프트·툴 설명·지식·루프 휴리스틱을 가르는 **유일한** 판별이다. 요청 하나 안에서는
 * 시작할 때 한 번 읽어 고정한다 — 루프 도중 프로필을 바꿔도 세트가 섞이지 않게.
 */
export type Backend = "local" | "claude";

export function activeBackend(): Backend {
  return isClaudeUrl(useSettingsStore.getState().llmUrl) ? "claude" : "local";
}

// ── Claude 서버 툴 ───────────────────────────────────────────────────────────

/** 모델이 서버에서 직접 돌리는 툴. Models API 의 capabilities.server_tools 로 안다. */
export interface ServerToolCaps {
  web_search: boolean;
  web_fetch: boolean;
}

/** 모델별 서버 툴 능력. 활성 Claude 프로필을 고를 때 한 번 물어 채운다(claude-caps). */
const serverCaps = new Map<string, ServerToolCaps>();

export function setServerToolCaps(model: string, caps: ServerToolCaps): void {
  serverCaps.set(model, caps);
  // 툴 목록이 바뀌니 구독자(모델 칩 등)가 다시 그리게 아무 상태나 건드린다.
  useSettingsStore.setState({ serverCapsVersion: useSettingsStore.getState().serverCapsVersion + 1 });
}

export function getServerToolCaps(model: string): ServerToolCaps | null {
  return serverCaps.get(model) ?? null;
}

/**
 * 지금 요청에 붙일 서버 툴. Claude 가 활성이고 그 모델이 지원한다고 확인된 것만.
 * 확인 전(앱 켠 직후)엔 비어 있고, 그동안은 로컬 툴(web.search/web.scrape)이 그대로 쓰인다.
 */
export function activeServerTools(): Array<{ type: string; name: string; [k: string]: unknown }> {
  const { llmUrl } = useSettingsStore.getState();
  const model = claudeModelOf(llmUrl);
  if (!model) return [];
  const caps = serverCaps.get(model);
  if (!caps) return [];
  const out: Array<{ type: string; name: string; [k: string]: unknown }> = [];
  if (caps.web_search) out.push({ type: "web_search_20250305", name: "web_search", max_uses: 8 });
  if (caps.web_fetch) {
    out.push({ type: "web_fetch_20250910", name: "web_fetch", max_uses: 8, max_content_tokens: 20_000, citations: { enabled: true } });
  }
  return out;
}

/** 이 로컬 툴이 서버 툴로 대체돼 지금은 숨겨야 하는가. */
export function isReplacedByServerTool(serverEquivalent: string | undefined): boolean {
  if (!serverEquivalent) return false;
  return activeServerTools().some((t) => t.name === serverEquivalent);
}

/**
 * 툴 결과를 모델에게 돌려줄 때의 글자 상한. 로컬 8K 컨텍스트엔 500자가 한계였지만
 * Claude 는 64K 로 묶어도 넉넉하다 — 페이지 본문을 조각만 보고 답하게 할 이유가 없다.
 */
export function resultCap(): number {
  return activeBackend() === "claude" ? 4000 : 500;
}

/** 이번 호출에 native tool calling 을 쓸 것인가. */
export function shouldUseNativeTools(): boolean {
  const { toolMode, nativeToolsDegraded } = useSettingsStore.getState();
  // json 모드는 llama.cpp 의 GBNF grammar 로 출력을 묶는 방식이라 Claude 에선 성립하지 않는다.
  // Claude 는 툴 호출을 기본으로 지원하므로 설정과 무관하게 native 로 간다.
  if (activeBackend() === "claude") return true;
  if (toolMode === "json") return false;
  if (toolMode === "native") return true;
  return !nativeToolsDegraded;
}

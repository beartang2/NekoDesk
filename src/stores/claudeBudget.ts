import { create } from "zustand";
import { estimateCostUsd } from "../lib/claude-models";

/**
 * Claude 사용액 장부와 월 예산.
 *
 * Max 요금제의 API 크레딧은 달력의 1일이 아니라 **결제일**마다 새로 들어오고 남은 건
 * 이월되지 않는다. 그래서 장부도 사용자가 정한 "갱신일"에 0 으로 돌아간다.
 *
 * Console 에도 지출 한도가 있지만 두 겹으로 둔다. 같은 조직의 다른 키(다른 사이트)와
 * 잔액을 나눠 쓰고, Console 의 조직 한도는 매달 1일에 초기화돼서 크레딧 갱신일과 어긋날
 * 수 있다. 네코 몫은 네코가 스스로 세다가 넘기 전에 멈춘다.
 *
 * 금액은 응답의 usage(prompt/completion 토큰)로 계산한 추정치다. 정확한 청구액은
 * Console 의 Cost 페이지가 기준이다.
 */

export interface ClaudeUsage {
  /** 이 장부가 세기 시작한 날(로컬 날짜, YYYY-MM-DD). */
  periodStart: string;
  spentUsd: number;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export interface ClaudeBudgetSettings {
  /** 이번 주기에 네코가 쓸 수 있는 금액. 0 이하면 제한 없음. */
  budgetUsd: number;
  /** 크레딧이 새로 들어오는 날(1~28). 29~31일 결제는 28로 친다 — 2월에도 매달 오는 날이어야 한다. */
  resetDay: number;
}

export const DEFAULT_BUDGET: ClaudeBudgetSettings = { budgetUsd: 80, resetDay: 1 };

const USAGE_KEY = "nekodesk_claude_usage";
const SETTINGS_KEY = "nekodesk_claude_budget";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function clampResetDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(28, Math.max(1, Math.round(day)));
}

/** `now` 가 속한 주기의 시작일. 갱신일 전이면 지난달 갱신일부터다. */
export function periodStartFor(now: Date, resetDay: number): string {
  const day = clampResetDay(resetDay);
  let y = now.getFullYear();
  let m = now.getMonth(); // 0-based
  if (now.getDate() < day) {
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  return `${y}-${pad(m + 1)}-${pad(day)}`;
}

/** 다음 갱신일(로컬 날짜). 화면에 "N일 남음" 을 띄울 때 쓴다. */
export function nextResetFor(now: Date, resetDay: number): string {
  const [y, m] = periodStartFor(now, resetDay).split("-").map(Number);
  const next = new Date(y, m, clampResetDay(resetDay)); // m 은 1-based 라 그대로 넣으면 다음 달
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}`;
}

function emptyUsage(periodStart: string): ClaudeUsage {
  return { periodStart, spentUsd: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
}

function loadSettings(): ClaudeBudgetSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<ClaudeBudgetSettings>) : {};
    return {
      budgetUsd: typeof parsed.budgetUsd === "number" ? parsed.budgetUsd : DEFAULT_BUDGET.budgetUsd,
      resetDay: clampResetDay(parsed.resetDay ?? DEFAULT_BUDGET.resetDay),
    };
  } catch {
    return { ...DEFAULT_BUDGET };
  }
}

function loadUsage(): ClaudeUsage | null {
  try {
    const raw = localStorage.getItem(USAGE_KEY);
    return raw ? (JSON.parse(raw) as ClaudeUsage) : null;
  } catch {
    return null;
  }
}

/** 장부가 지난 주기 것이면 새 주기로 넘긴다. */
export function rollover(usage: ClaudeUsage | null, now: Date, resetDay: number): ClaudeUsage {
  const start = periodStartFor(now, resetDay);
  return usage && usage.periodStart === start ? usage : emptyUsage(start);
}

interface ClaudeBudgetStore {
  settings: ClaudeBudgetSettings;
  usage: ClaudeUsage;
  setSettings: (s: Partial<ClaudeBudgetSettings>) => void;
  /** 응답 하나가 끝날 때 부른다. promptTokens 는 캐시 포함 전체 입력. */
  record: (
    model: string,
    promptTokens: number,
    completionTokens: number,
    extra?: { cacheRead?: number; cacheWrite?: number; webSearches?: number }
  ) => void;
  /** 화면을 다시 그리기 전에 주기가 바뀌었는지 확인한다(앱을 며칠 켜둔 경우). */
  refresh: () => void;
}

const initialSettings = loadSettings();

export const useClaudeBudget = create<ClaudeBudgetStore>((set, get) => ({
  settings: initialSettings,
  usage: rollover(loadUsage(), new Date(), initialSettings.resetDay),

  setSettings: (patch) => {
    const settings = {
      ...get().settings,
      ...patch,
      resetDay: clampResetDay(patch.resetDay ?? get().settings.resetDay),
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    // 갱신일을 바꾸면 지금 주기도 바뀔 수 있다. 같은 주기면 지금까지 쓴 건 그대로 둔다.
    const usage = rollover(get().usage, new Date(), settings.resetDay);
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
    set({ settings, usage });
  },

  record: (model, promptTokens, completionTokens, extra = {}) => {
    const base = rollover(get().usage, new Date(), get().settings.resetDay);
    const usage: ClaudeUsage = {
      ...base,
      spentUsd: base.spentUsd + estimateCostUsd(model, promptTokens, completionTokens, extra),
      inputTokens: base.inputTokens + promptTokens,
      outputTokens: base.outputTokens + completionTokens,
      requests: base.requests + 1,
    };
    localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
    set({ usage });
  },

  refresh: () => {
    const usage = rollover(get().usage, new Date(), get().settings.resetDay);
    if (usage !== get().usage) {
      localStorage.setItem(USAGE_KEY, JSON.stringify(usage));
      set({ usage });
    }
  },
}));

/** 예산을 다 썼으면 그 이유를 담은 메시지, 아니면 null. 요청을 보내기 직전에 부른다. */
export function budgetBlockReason(): string | null {
  const store = useClaudeBudget.getState();
  store.refresh();
  const { settings, usage } = useClaudeBudget.getState();
  if (settings.budgetUsd <= 0 || usage.spentUsd < settings.budgetUsd) return null;
  const next = nextResetFor(new Date(), settings.resetDay);
  return `이번 주기 Claude 예산 $${settings.budgetUsd} 를 다 썼어($${usage.spentUsd.toFixed(2)}). ` +
    `${next} 에 다시 쓸 수 있어. 급하면 설정 → 모델 프로필에서 예산을 늘리거나 로컬 모델로 바꿔줘.`;
}

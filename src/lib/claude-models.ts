/**
 * Claude 모델 목록·가격·주소 표기. 다른 모듈을 import 하지 않는다(settingsStore 와 순환을 피한다).
 *
 * 프로필 쪽에선 Claude 를 "주소가 claude:// 로 시작하는 외부 프로필"로 다룬다. 그러면
 * settingsStore.llmUrl 하나로 지금 어디에 묻는지가 다 표현돼서, llmUrl 을 구독하던 곳
 * (컨텍스트 게이지, 모델 정보 폴링)이 프로필을 바꿀 때 손대지 않아도 같이 따라온다.
 */

export const CLAUDE_URL_PREFIX = "claude://";

export interface ClaudePrice {
  /** 100만 토큰당 USD. */
  input: number;
  output: number;
  /** 프롬프트 캐시 쓰기(5분)·읽기. 네이티브 API 로 갈 때 자동 캐싱이 이걸로 청구된다. */
  cacheWrite: number;
  cacheRead: number;
  /**
   * 프롬프트가 이 토큰 수를 넘는 요청은 그 요청 전체가 long* 가격이다(Haiku 5.5 만 해당).
   * 없으면 길이 구간이 없다.
   */
  longThreshold?: number;
  longInput?: number;
  longOutput?: number;
  longCacheWrite?: number;
  longCacheRead?: number;
}

export interface ClaudeModel {
  id: string;
  label: string;
  hint: string;
  price: ClaudePrice;
}

/**
 * 2026-10 공식 가격표(platform.claude.com/docs/en/about-claude/pricing) 기준.
 * OpenAI 호환 계층은 프롬프트 캐싱을 안 하므로 캐시 가격은 쓸 일이 없다.
 */
export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  {
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
    hint: "제일 싸고 빠름",
    price: {
      input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01,
      longThreshold: 100_000, longInput: 0.5, longOutput: 2.5, longCacheWrite: 0.625, longCacheRead: 0.05,
    },
  },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", hint: "균형", price: { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.1 } },
  { id: "claude-opus-5-5", label: "Opus 5.5", hint: "가장 똑똑함 · 비쌈", price: { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 } },
];

export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS[0].id;

/**
 * Claude 로 보낼 때 max_tokens 의 바닥. Claude 5 모델은 적응형 생각이 기본으로 켜져 있고
 * 생각 토큰도 max_tokens 에 포함된다. 끝말잇기(20)·기억 판정(8)처럼 아주 짧게 잡은 호출은
 * 생각만 하다 잘려 답이 비어 버린다. 실제로 쓴 만큼만 청구되므로 바닥을 올려도 비용은 그대로다.
 */
export const CLAUDE_MIN_MAX_TOKENS = 4096;

/**
 * 네코에게 알려주는 컨텍스트 길이. 모델 자체는 1M 까지 받지만 그대로 알려주면 에이전트가
 * 대화·툴 결과를 그만큼 채운다. Haiku 5.5 는 프롬프트가 10만 토큰을 넘는 순간 그 요청이
 * 통째로 5배 가격이 되니, 네코의 토큰 추정이 크게 빗나가도(token-estimate 는 실제의
 * 0.6~2배) 그 선 아래에 머물 만큼 묶어둔다.
 */
export const CLAUDE_CONTEXT_CAP = 64_000;

export function isClaudeUrl(url: string | null | undefined): boolean {
  return !!url && url.startsWith(CLAUDE_URL_PREFIX);
}

export function claudeUrl(model: string): string {
  return `${CLAUDE_URL_PREFIX}${model}`;
}

/** claude://claude-haiku-5-5 → claude-haiku-5-5. Claude 주소가 아니면 null. */
export function claudeModelOf(url: string | null | undefined): string | null {
  if (!isClaudeUrl(url)) return null;
  const id = url!.slice(CLAUDE_URL_PREFIX.length).trim();
  return id || DEFAULT_CLAUDE_MODEL;
}

export function findClaudeModel(id: string): ClaudeModel | undefined {
  return CLAUDE_MODELS.find((m) => m.id === id);
}

export function claudeLabel(id: string): string {
  return `Claude ${findClaudeModel(id)?.label ?? id}`;
}

/**
 * 요청 한 건의 비용(USD). 목록에 없는 모델은 가장 비싼 값으로 친다 — 모르는 걸 싸게
 * 잡으면 예산 상한이 늦게 걸린다.
 *
 * `promptTokens` 는 캐시에서 읽은 것·캐시에 쓴 것까지 합친 **전체 입력**이다(길이 구간 판정은
 * 전체로 한다). 캐시 토큰은 따로 주면 그 요율로 뺀다. 웹 검색은 1,000회당 $10 이 더 붙는다.
 */
export function estimateCostUsd(
  model: string,
  promptTokens: number,
  completionTokens: number,
  extra: { cacheRead?: number; cacheWrite?: number; webSearches?: number } = {}
): number {
  const fallback = CLAUDE_MODELS[CLAUDE_MODELS.length - 1].price;
  const p = findClaudeModel(model)?.price ?? fallback;
  const long = p.longThreshold !== undefined && promptTokens > p.longThreshold;
  const inRate = long ? p.longInput ?? p.input : p.input;
  const outRate = long ? p.longOutput ?? p.output : p.output;
  const readRate = long ? p.longCacheRead ?? p.cacheRead : p.cacheRead;
  const writeRate = long ? p.longCacheWrite ?? p.cacheWrite : p.cacheWrite;
  const cacheRead = extra.cacheRead ?? 0;
  const cacheWrite = extra.cacheWrite ?? 0;
  const fresh = Math.max(0, promptTokens - cacheRead - cacheWrite);
  const tokens = (fresh * inRate + cacheRead * readRate + cacheWrite * writeRate + completionTokens * outRate) / 1_000_000;
  return tokens + (extra.webSearches ?? 0) * 0.01;
}

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
  /**
   * 프롬프트가 이 토큰 수를 넘는 요청은 그 요청 전체가 long* 가격이다(Haiku 5.5 만 해당).
   * 없으면 길이 구간이 없다.
   */
  longThreshold?: number;
  longInput?: number;
  longOutput?: number;
}

export interface ClaudeModel {
  id: string;
  label: string;
  hint: string;
  price: ClaudePrice;
  /** 네코에게 알려주는 컨텍스트 길이(토큰). 아래 CLAUDE_MODELS 위 주석 참고. */
  contextCap: number;
  /** 응답 한 번에 받을 수 있는 max_tokens 의 천장. 넘기면 요청 전체가 400 이다. */
  maxOutput: number;
}

/**
 * 2026-10 공식 가격표(platform.claude.com/docs/en/about-claude/pricing) 기준.
 * OpenAI 호환 계층은 프롬프트 캐싱을 안 하므로 캐시 가격은 쓸 일이 없다.
 *
 * contextCap — 모델 자체는 1M 까지 받지만 그대로 알려주면 에이전트가 대화·툴 결과를
 * 그만큼 채우고(agent-context), 캐싱이 없으니 요청마다 그 전부가 입력 요금이다. 그래서
 * 창 크기가 곧 요청 한 번의 값이다. 월 크레딧 $80 로 한 달에 요청 2,000번쯤(하루 65번,
 * 에이전트 단계 포함)을 쓴다고 치고, 프롬프트가 평균 창의 절반쯤 찬다고 보면:
 *  - Sonnet 32K: 입력 2,000 × 16K × $2 ≈ $64 + 출력(500토큰) ≈ $10 → $74
 *  - Opus   16K: 입력 2,000 ×  8K × $4 ≈ $64 + 출력(500토큰) ≈ $20 → $84 (예산 상한이 막는다)
 *  - Haiku 는 돈이 아니라 가격 구간이 한계다. 프롬프트가 10만 토큰을 넘는 순간 그 요청이
 *    통째로 5배 가격이 되니, 네코의 토큰 추정이 크게 빗나가도(token-estimate 는 실제의
 *    0.6~2배) 그 선 아래에 머물 만큼 64K 로 묶는다. 이때도 한 달 $7 남짓이다.
 */
export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  {
    id: "claude-haiku-5-5",
    label: "Haiku 5.5",
    hint: "제일 싸고 빠름",
    price: { input: 0.1, output: 0.5, longThreshold: 100_000, longInput: 0.5, longOutput: 2.5 },
    contextCap: 64_000,
    maxOutput: 128_000,
  },
  {
    id: "claude-sonnet-5-5",
    label: "Sonnet 5.5",
    hint: "균형",
    price: { input: 2, output: 10 },
    contextCap: 32_000,
    maxOutput: 128_000,
  },
  {
    id: "claude-opus-5-5",
    label: "Opus 5.5",
    hint: "가장 똑똑함 · 비쌈",
    price: { input: 4, output: 20 },
    contextCap: 16_000,
    maxOutput: 128_000,
  },
];

export const DEFAULT_CLAUDE_MODEL = CLAUDE_MODELS[0].id;

/** 내장 웹 검색 1회 값. 토큰값과 따로 붙는다($10 / 1,000회, platform.claude.com 웹 검색 툴 문서). */
export const WEB_SEARCH_USD = 0.01;

/**
 * 내장 웹 검색을 돌리는 모델. 메인 대화 모델과 상관없이 가장 싼 Haiku 로 고정한다.
 * 검색 결과는 통째로 입력 토큰이 돼 한 번에 수만 토큰이 되기도 한다 — Opus 로 돌리면 검색
 * 한 번에 수십 센트다. 찾아 읽고 정리하는 일이라 Haiku 로 충분하고, 판단은 메인 모델이 한다.
 */
export const WEB_SEARCH_MODEL = "claude-haiku-5-5";


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

/**
 * 네코에게 알려주는 컨텍스트 길이. 모델 자체는 1M 까지 받지만 그대로 알려주면 에이전트가
 * 대화·툴 결과를 그만큼 채운다. Haiku 5.5 는 프롬프트가 10만 토큰을 넘는 순간 그 요청이
 * 통째로 5배 가격이 되니, 네코의 토큰 추정이 크게 빗나가도(token-estimate 는 실제의
 * 0.6~2배) 그 선 아래에 머물 만큼 묶어둔다.
 */
export const CLAUDE_CONTEXT_CAP = 64_000;

/** 그 모델로 네코에게 알려줄 컨텍스트 길이. 모르는 모델은 가장 작은 창으로 친다(비싸게 잡는다). */
export function claudeContextCap(id: string): number {
  return findClaudeModel(id)?.contextCap ?? Math.min(...CLAUDE_MODELS.map((m) => m.contextCap));
}

/**
 * 이 주소로 보낼 수 있는 max_tokens 의 천장. 로컬 서버는 정해진 천장이 없어 null.
 * 모르는 Claude 모델은 가장 낮은 천장으로 친다.
 */
export function maxOutputTokensFor(url: string | null | undefined): number | null {
  const id = claudeModelOf(url);
  if (!id) return null;
  return findClaudeModel(id)?.maxOutput ?? Math.min(...CLAUDE_MODELS.map((m) => m.maxOutput));
}

export function claudeLabel(id: string): string {
  return `Claude ${findClaudeModel(id)?.label ?? id}`;
}

/**
 * 요청 한 건의 비용(USD). 목록에 없는 모델은 가장 비싼 값으로 친다 — 모르는 걸 싸게
 * 잡으면 예산 상한이 늦게 걸린다.
 */
export function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const fallback = CLAUDE_MODELS[CLAUDE_MODELS.length - 1].price;
  const p = findClaudeModel(model)?.price ?? fallback;
  const long = p.longThreshold !== undefined && promptTokens > p.longThreshold;
  const inRate = long ? p.longInput ?? p.input : p.input;
  const outRate = long ? p.longOutput ?? p.output : p.output;
  return (promptTokens * inRate + completionTokens * outRate) / 1_000_000;
}

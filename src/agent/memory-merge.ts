import { memoryApi } from "../api/tauri";
import { fetchCompletion } from "./llm-client";
import type { Memory } from "./types";

/**
 * 새 기억이 예전 기억을 대신하면 예전 것을 지운다.
 *
 * 똑같은 글은 DB 가 막지만, 모델은 같은 사실을 말만 바꿔 또 저장한다("율리오는 친구" 와
 * "율리오는 AI 친구"). 사실이 바뀌기도 한다("커피를 좋아한다" → "싫어한다"). 둘 다 남으면
 * 떠올릴 때 엇갈린 기억이 같이 붙는다.
 *
 * 글자 겹침만으로는 못 가른다 — "아빠 생일은 3월 2일" 과 "엄마 생일은 3월 2일" 이 더
 * 겹친다(0.75 대 율리오 두 줄 0.64). 그래서 겹침으로 후보만 고르고 같은지는 모델이 정한다.
 * 문법으로 답을 두 낱말에 묶고 생각을 끄면 한 쌍에 0.5초쯤 걸린다(8쌍 실측 모두 맞음).
 */

/** 모델에 물어볼 후보 수. 한 쌍에 0.5초쯤. */
const CANDIDATES = 3;

const JUDGE_SYSTEM =
  '두 기억을 비교해. 새 기억이 예전 기억의 내용을 빠짐없이 담고 있거나, 같은 것에 대해 사실이 바뀐 거면 "대체", 아니면 "따로"로만 답해.';
const JUDGE_GRAMMAR = 'root ::= "대체" | "따로"';

/** 공백·문장부호를 뺀 두 글자 조각. */
function bigrams(s: string): Set<string> {
  const t = s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 짧은 쪽 조각 중 몇이 겹치나(0~1). */
function overlap(mine: Set<string>, theirs: Set<string>): number {
  let shared = 0;
  for (const b of theirs) if (mine.has(b)) shared++;
  return shared / Math.max(1, Math.min(mine.size, theirs.size));
}

/** 두 글자 조각이 겹치는 정도가 큰 순으로 후보. 하나도 안 겹치면 뺀다. */
export function similarMemories(content: string, all: Memory[], limit = CANDIDATES): Memory[] {
  const mine = bigrams(content);
  return all
    .filter((m) => m.content !== content)
    .map((m) => ({ m, score: overlap(mine, bigrams(m.content)) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

async function replaces(older: string, newer: string): Promise<boolean> {
  const answer = await fetchCompletion(
    [
      { role: "system", content: JUDGE_SYSTEM },
      { role: "user", content: `예전 기억: ${older}\n새 기억: ${newer}` },
    ],
    { max_tokens: 8, temperature: 0, grammar: JUDGE_GRAMMAR }
  );
  return answer.trim().endsWith("대체");
}

/*
 * 도구로 바로 찾아볼 수 있는 건(일정·할 일·파일·설정·기기 상태) 기억하지 않는다. "일정 등록해 줘" 한 내용이
 * 취향 기억으로 남으면 일정이 바뀌거나 지워져도 기억은 옛 것을 떠올린다. 시스템 프롬프트를 늘리지 않고
 * 저장할 때 생각 끈 작은 판정으로 거른다. 판정이 안 되면(꺼짐·시간 초과) 저장한다 — 잃는 쪽으로 틀리지 않게.
 */
const KEEP_SYSTEM =
  '기억으로 남길지 정해. 일정·할 일·미리 알림·파일·앱 설정·지금 기기 상태처럼 도구로 바로 찾아볼 수 있는 거면 "안함", ' +
  '취향·습관·이름·관계·진행 중인 일처럼 찾아볼 수 없는 거면 "저장"으로만 답해.';
const KEEP_GRAMMAR = 'root ::= "저장" | "안함"';
const KEEP_TIMEOUT_MS = 8000;
export const SKIP_LOOKUP = "도구로 찾아볼 수 있는 건 기억하지 않아";

/** 방금 만든 일정·할 일. 같은 내용을 기억하려 하면 판정 없이 막는다. */
const RECENT_MS = 30 * 60_000;
const created: { at: number; grams: Set<string> }[] = [];
export function noteCreated(text: string): void {
  const grams = bigrams(text);
  if (grams.size >= 2) created.push({ at: Date.now(), grams });
  if (created.length > 20) created.shift();
}
// ponytail: 대화 구분 없이 30분 안에 만든 것. 다른 창에서 같은 걸 기억하려 해도 막히지만 그것도 찾아볼 수 있는 내용이다
function justCreated(text: string): boolean {
  const mine = bigrams(text), since = Date.now() - RECENT_MS;
  return created.some((c) => c.at >= since && overlap(mine, c.grams) >= 0.6);
}

export async function lookupable(text: string): Promise<boolean> {
  const answer = await fetchCompletion(
    [
      { role: "system", content: KEEP_SYSTEM },
      { role: "user", content: text },
    ],
    { max_tokens: 8, temperature: 0, grammar: KEEP_GRAMMAR },
    undefined,
    AbortSignal.timeout(KEEP_TIMEOUT_MS),
  );
  return answer.trim().endsWith("안함");
}

export type SaveResult = (Memory & { replaced: string[] }) | { skipped: string; content: string };

/**
 * 저장하고, 새 기억이 대신하게 된 예전 기억은 지운다. 판정이 안 되면 그냥 저장만.
 * 사용자 기억이 도구로 찾아볼 수 있는 거면 저장하지 않고 skipped 를 돌려준다(산책 기억은 거르지 않는다).
 */
export async function saveMemory(content: string, kind: string): Promise<SaveResult> {
  const text = content.trim();
  if (kind !== "neko" && (justCreated(text) || (await lookupable(text).catch(() => false)))) {
    return { skipped: SKIP_LOOKUP, content: text };
  }
  const stale: Memory[] = [];
  try {
    // 산책 기억(neko)은 웹에서 온 것이라 사용자 기억을 대신하지 못하게 같은 쪽끼리만 견준다.
    const sameSide = (await memoryApi.list()).filter((m) => (m.kind === "neko") === (kind === "neko"));
    for (const m of similarMemories(text, sameSide)) {
      if (await replaces(m.content, text)) stale.push(m);
    }
  } catch {
    // 모델이 꺼져 있어도 기억은 남아야 한다. 중복은 다음 저장 때 다시 본다.
  }
  const saved = await memoryApi.save(text, kind);
  for (const m of stale) await memoryApi.delete(m.id).catch(() => false);
  return { ...saved, replaced: stale.map((m) => m.content) };
}

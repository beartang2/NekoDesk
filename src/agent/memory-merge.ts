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

/** 두 글자 조각이 겹치는 정도가 큰 순으로 후보. 하나도 안 겹치면 뺀다. */
export function similarMemories(content: string, all: Memory[], limit = CANDIDATES): Memory[] {
  const mine = bigrams(content);
  return all
    .filter((m) => m.content !== content)
    .map((m) => {
      const theirs = bigrams(m.content);
      let shared = 0;
      for (const b of theirs) if (mine.has(b)) shared++;
      return { m, score: shared / Math.max(1, Math.min(mine.size, theirs.size)) };
    })
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

/** 저장하고, 새 기억이 대신하게 된 예전 기억은 지운다. 판정이 안 되면 그냥 저장만. */
export async function saveMemory(content: string, kind: string): Promise<Memory & { replaced: string[] }> {
  const text = content.trim();
  const stale: Memory[] = [];
  try {
    for (const m of similarMemories(text, await memoryApi.list())) {
      if (await replaces(m.content, text)) stale.push(m);
    }
  } catch {
    // 모델이 꺼져 있어도 기억은 남아야 한다. 중복은 다음 저장 때 다시 본다.
  }
  const saved = await memoryApi.save(text, kind);
  for (const m of stale) await memoryApi.delete(m.id).catch(() => false);
  return { ...saved, replaced: stale.map((m) => m.content) };
}

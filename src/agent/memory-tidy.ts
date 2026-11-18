import { memoryApi, settingsApi } from "../api/tauri";
import { fetchCompletionMessage } from "./llm-client";
import type { Memory, OpenAiToolSchema } from "./types";

/**
 * 쉴 때 기억 정리. 네코가 졸 때 하루 한 번 돈다(트리거는 neko/memoryTidy.ts).
 *
 * memory-merge.ts 는 저장할 때 새 기억 하나를 비슷한 몇 개와 견준다. 그래도 말만 바꾼 기억이 쌓인다.
 * 여기선 모델이 목록 전체를 보고 겹치는 묶음과 합친 한 줄을 고른다. 검사를 통과한 묶음만 합친 줄을
 * 저장하고 원래 것을 지운다. 따로인 기억은 지우지 않는다. 무엇을 합쳤는지는 기록(TIDY_LOG_KEY)에
 * 남겨 설정에서 볼 수 있다. 정리 지시는 이 호출에만 있다(시스템 프롬프트는 그대로).
 */

export interface TidyMerge {
  /** 합치기 전 기억들 */
  from: string[];
  /** 합친 기억 */
  to: string;
}
export interface TidyRecord {
  /** ISO 시각 */
  at: string;
  merges: TidyMerge[];
}

/** 정리 기록(settings DB). 최근 것이 앞 */
export const TIDY_LOG_KEY = "neko_memory_tidy_log";
const LOG_MAX = 30;
/** 합친 줄 길이 상한. 모델이 묶음을 줄글로 풀어 쓰지 않게 */
const MAX_LEN = 400;

const TIDY_TOOL = {
  type: "function",
  function: {
    name: "memory_tidy",
    description: "겹치는 기억 묶음과 합친 한 줄을 낸다",
    parameters: {
      type: "object",
      properties: {
        merges: {
          type: "array",
          items: {
            type: "object",
            properties: {
              ids: { type: "array", items: { type: "integer" }, description: "합칠 기억 번호(2개 이상)" },
              content: { type: "string", description: "합친 기억 한 줄" },
            },
            required: ["ids", "content"],
          },
        },
      },
      required: ["merges"],
    },
  },
} as OpenAiToolSchema;

const SYSTEM = [
  "저장된 기억 목록을 정리한다. memory_tidy 툴로 답해.",
  "같은 사실을 말만 바꿔 여러 번 적은 기억, 또는 같은 대상에 대해 사실이 바뀐 기억끼리만 묶어 한 줄로 합쳐.",
  "합친 줄은 묶은 기억의 내용을 빠짐없이 담는다. 사실이 바뀐 경우엔 번호가 큰(나중에 적은) 쪽을 따른다.",
  "주제만 비슷하고 내용이 다른 기억은 묶지 마. 사용자 기억과 산책 기억은 서로 묶지 마.",
  "합칠 게 없으면 merges 를 비워.",
].join("\n");

const isWalk = (m: Memory) => m.kind === "neko";

/** 모델이 낸 묶음을 검사한다: 있는 번호, 두 개 이상, 한 번씩만, 같은 쪽(사용자·산책)끼리, 빈 줄·너무 긴 줄 아님. */
export function checkMerges(raw: unknown, all: Memory[]): { ids: number[]; content: string; kind: string }[] {
  const byId = new Map(all.map((m) => [m.id, m]));
  const used = new Set<number>();
  const out: { ids: number[]; content: string; kind: string }[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const rec = (item ?? {}) as { ids?: unknown; content?: unknown };
    const ids = [...new Set((Array.isArray(rec.ids) ? rec.ids : []).map(Number))].filter((id) => byId.has(id) && !used.has(id));
    const content = typeof rec.content === "string" ? rec.content.trim() : "";
    if (ids.length < 2 || !content || content.length > MAX_LEN) continue;
    const side = isWalk(byId.get(ids[0])!);
    if (!ids.every((id) => isWalk(byId.get(id)!) === side)) continue;
    ids.forEach((id) => used.add(id));
    // 종류는 나중에 적은 쪽을 따른다
    out.push({ ids, content, kind: byId.get(Math.max(...ids))!.kind });
  }
  return out;
}

/** 정리를 한 번 돈다. 합친 게 있으면 기록에 남기고 그 기록을 돌려준다. 없으면 null. */
export async function tidyMemories(signal?: AbortSignal): Promise<TidyRecord | null> {
  const all = await memoryApi.list();
  if (all.length < 2) return null;
  const list = (side: boolean) =>
    all.filter((m) => isWalk(m) === side).sort((a, b) => a.id - b.id).map((m) => `${m.id}: ${m.content}`).join("\n") || "(없음)";
  const turn = await fetchCompletionMessage(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: `## 사용자 기억\n${list(false)}\n\n## 산책 기억\n${list(true)}` },
    ],
    { tools: [TIDY_TOOL] },
    undefined,
    signal,
  );
  if (signal?.aborted) return null;
  const merges = checkMerges(turn.toolCalls.find((c) => c.name === "memory_tidy")?.params?.merges, all);
  if (!merges.length) return null;

  const byId = new Map(all.map((m) => [m.id, m]));
  const done: TidyMerge[] = [];
  for (const m of merges) {
    const saved = await memoryApi.save(m.content, m.kind);
    // 합친 줄이 원래 있던 줄과 같으면 그 줄은 남긴다
    for (const id of m.ids) if (id !== saved.id) await memoryApi.delete(id).catch(() => false);
    done.push({ from: m.ids.map((id) => byId.get(id)!.content), to: saved.content });
  }
  const record: TidyRecord = { at: new Date().toISOString(), merges: done };
  const log = await loadTidyLog();
  await settingsApi.set(TIDY_LOG_KEY, JSON.stringify([record, ...log].slice(0, LOG_MAX))).catch(() => {});
  return record;
}

export async function loadTidyLog(): Promise<TidyRecord[]> {
  try {
    const raw = await settingsApi.get(TIDY_LOG_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? (parsed as TidyRecord[]) : [];
  } catch {
    return [];
  }
}

import { memoryApi, settingsApi } from "../api/tauri";
import { walkEnd, type Walk } from "../lib/walk";
import { timeZone } from "../lib/time";
import { useNekoApp } from "../neko/director/stores";
import { followState } from "../neko/presence";
import { budgetBlockReason } from "../stores/claudeBudget";
import { isClaudeActive, nekoNameOf, useSettingsStore } from "../stores/settingsStore";
import { DEFAULT_CHAT_SYSTEM_PROMPT, fetchCompletionMessage } from "./llm-client";
import { heartLines, LINE_MAX, loadHeart, SECRETS_MAX, TRAIT_KINDS, TRAITS_MAX, updateHeart, unfolded, untoldSecrets, type NekoHeart, type Trait, type TraitKind } from "./neko-heart";
import { activityText, leaksFact, loadMind, mindMaterial } from "./neko-mind";
import type { Memory, OpenAiToolSchema } from "./types";

/**
 * 쉴 때 성격 굳히기(docs/neko-heart.md §3): 하루 한 번, 굳힌 뒤 쌓인 노트(사건)와 지금 성격을 보고 네코가 성격을 고쳐 쓴다 —
 * 새로 굳은 것(add), 다시 맞는 것(keep), 바뀐 것(revise, 새것이 이긴다), 더는 아닌 것(drop). 규칙·예시 없이 재료만 준다.
 * 사용자 사실은 안 보이고(취향만) 성격 글마다 사실 조각을 걸러, 성격이 산책 주제 재료로 다시 쓰여도 웹으로 새지 않는다.
 * 한 번에 더하기·버리기 5개까지 — 웹 글이 섞인 노트가 성격을 크게 흔들지 못하게. 이 지시는 이 호출에만 있다(시스템 프롬프트 그대로)
 */

const FOLD_MS = 30_000;
const STEP_MAX = 5;
const LOG_KEY = "neko_heart_log";
const LOG_MAX = 30;

const KIND_DESC = "like 좋아하는 것 · dislike 싫어하는 것 · habit 버릇 · fear 겁내는 것 · rule 자기만의 규칙 · secret 사용자에게 아직 말하지 않은 것";
const FOLD_TOOL = {
  type: "function",
  function: {
    name: "heart_fold",
    description: "성격을 고쳐 쓴다",
    parameters: {
      type: "object",
      properties: {
        add: {
          type: "array",
          description: "새로 굳은 성격",
          items: {
            type: "object",
            properties: { kind: { type: "string", enum: TRAIT_KINDS, description: KIND_DESC }, text: { type: "string", description: "한 줄" } },
            required: ["kind", "text"],
          },
        },
        keep: { type: "array", items: { type: "string" }, description: "이번 사건들이 다시 뒷받침한 성격 번호" },
        revise: {
          type: "array",
          description: "바뀐 성격(새것이 이긴다)",
          items: {
            type: "object",
            properties: { id: { type: "string" }, kind: { type: "string", enum: TRAIT_KINDS }, text: { type: "string", description: "한 줄" } },
            required: ["id", "text"],
          },
        },
        drop: { type: "array", items: { type: "string" }, description: "더는 아닌 성격 번호" },
      },
    },
  },
} as OpenAiToolSchema;

export interface FoldRecord {
  at: string;
  add: string[];
  revise: { from: string; to: string }[];
  drop: string[];
  keep: number;
}

const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: timeZone() });
const line = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, LINE_MAX) : "");
const isKind = (v: unknown): v is TraitKind => typeof v === "string" && (TRAIT_KINDS as readonly string[]).includes(v);
const newId = () => `t${Math.random().toString(36).slice(2, 8)}`;

/**
 * 모델이 낸 것 → 성격에 적용한 새 값과 기록(순수 함수 — 시험한다). 모르는 종류·빈 글·사실 조각·없는 번호는 버리고, 더하기·버리기는
 * STEP_MAX 까지, 상한(성격 40·안 털어놓은 비밀 5)을 넘는 더하기는 안 받는다
 */
export function applyFold(h: NekoHeart, raw: Record<string, unknown> | undefined, memories: Memory[], today: string, folded: string): { heart: NekoHeart; record: Omit<FoldRecord, "at"> } {
  const byId = new Map(h.traits.map((t) => [t.id, t]));
  const ok = (text: string) => !!text && !leaksFact(text, memories);
  const ids = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && byId.has(x)))];
  const record: Omit<FoldRecord, "at"> = { add: [], revise: [], drop: [], keep: 0 };
  let traits: Trait[] = h.traits.map((t) => ({ ...t }));
  const find = (id: string) => traits.find((t) => t.id === id);

  for (const id of ids(raw?.drop).slice(0, STEP_MAX)) {
    record.drop.push(byId.get(id)!.text);
    traits = traits.filter((t) => t.id !== id);
  }
  for (const r of (Array.isArray(raw?.revise) ? raw!.revise : []) as Record<string, unknown>[]) {
    const t = typeof r?.id === "string" ? find(r.id) : undefined, text = line(r?.text);
    if (!t || !ok(text)) continue;
    record.revise.push({ from: t.text, to: text });
    Object.assign(t, { text, at: today, n: t.n + 1, ...(isKind(r.kind) ? { kind: r.kind } : {}) });
    if (t.kind !== "secret") delete t.told;
  }
  for (const id of ids(raw?.keep)) {
    const t = find(id);
    if (t && t.at !== today) { t.at = today; t.n += 1; record.keep++; }
  }
  for (const r of ((Array.isArray(raw?.add) ? raw!.add : []) as Record<string, unknown>[]).slice(0, STEP_MAX)) {
    const text = line(r?.text);
    if (!isKind(r?.kind) || !ok(text) || traits.some((t) => t.text === text)) continue;
    if (traits.length >= TRAITS_MAX || (r.kind === "secret" && untoldSecrets({ v: 1, traits }).length >= SECRETS_MAX)) continue;
    traits.push({ id: newId(), kind: r.kind, text, since: today, at: today, n: 1 });
    record.add.push(text);
  }
  return { heart: { v: 1, traits, folded, day: today }, record };
}

/** 지금 굳혀도 되나. 안 되면 까닭 */
export async function foldBlock(today: string): Promise<string | null> {
  if (isClaudeActive() && budgetBlockReason()) return "예산을 다 씀";
  if (useNekoApp.getState().feeding) return "밥 먹는 중";
  if (followState() !== null) return "다른 기기가 앞";
  if ((await loadHeart()).day === today) return "오늘 이미 함";
  const raw = await settingsApi.get("neko_walk").catch(() => null);
  const w = raw ? (JSON.parse(raw) as Walk) : null;
  if (w?.path?.length && !w.done) return Date.now() < walkEnd(w) ? "산책 중" : "산책 보고를 기다리는 중";
  return null;
}

/** 굳히기 한 번(쉴 때 — neko/memoryTidy.ts). 바꾼 게 있으면 기록, 없으면 null. 실패하면 오늘은 다시 안 한다(다음 날) */
export async function foldHeart(signal?: AbortSignal): Promise<FoldRecord | null> {
  const today = ymd(new Date());
  if (await foldBlock(today)) return null;
  const mind = await loadMind(); // 성격(heart)도 같이 읽는다
  const heart = await loadHeart();
  // 고른 것(산책 주제·그림)은 사건 기록이지 속마음이 아니라 성격의 재료로 쓰지 않는다(사용자: 기억할 내용이 성격으로 들어온다)
  const felt = { ...mind, notes: mind.notes.filter((n) => n.kind !== "chose") };
  const events = unfolded(felt.notes, heart);
  // 하루 한 번만 해 보게 먼저 날을 적는다(실패해도 — 같은 실패로 매번 비용을 쓰지 않게)
  await updateHeart((h) => ({ ...h, day: today }));
  if (!events.length) return null;
  const memories = await memoryApi.list().catch((): Memory[] => []);
  const played = await activityText().catch(() => "");
  const name = nekoNameOf(useSettingsStore.getState());
  const persona = useSettingsStore.getState().systemPrompt?.trim() ?? "";
  const me = persona && persona !== DEFAULT_CHAT_SYSTEM_PROMPT.trim() ? persona : "";
  const ask = "최근 사건들을 보고 너는 어떤 고양이인지 성격을 고쳐 써. 새로 굳은 것은 add, 다시 맞는 것은 keep, 바뀐 것은 revise, 더는 아닌 것은 drop.";
  const material = [
    // 사용자 사실은 안 보인다(취향만) — 성격은 산책 주제의 재료로 다시 쓰인다
    ...mindMaterial(felt, memories, { facts: false }).filter((s) => !s.startsWith("## 나는 이런 고양이")),
    `## 지금 성격(번호·종류·글·사건 수)\n${heartLines(heart, { secrets: "all", ids: true }) || "(아직 없음)"}`,
    `## 굳힐 사건(노트)\n${events.map((n) => `- ${n.at.slice(0, 10)} ${n.kind}${n.what ? `(${n.what})` : ""}: ${n.text}${n.why ? ` — ${n.why}` : ""}`).join("\n")}`,
    played ? `## 최근 이틀 한 혼자 놀기\n${played}` : "",
  ].filter(Boolean);
  const ctrl = new AbortController(), stop = () => ctrl.abort(), timer = setTimeout(stop, FOLD_MS);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const turn = await fetchCompletionMessage(
      [
        { role: "system", content: [`너는 고양이 ${name}. heart_fold 툴로 답해.`, me && `네 성격과 말투:\n${me}`].filter(Boolean).join("\n\n") },
        { role: "user", content: [...material, `## 할 것\n${ask}`].join("\n\n") },
      ],
      { tools: [FOLD_TOOL] },
      undefined,
      ctrl.signal,
    );
    if (ctrl.signal.aborted) return null;
    const p = turn.toolCalls.find((c) => c.name === "heart_fold")?.params;
    if (!p) return null;
    const folded = events[events.length - 1].at;
    let record: Omit<FoldRecord, "at"> = { add: [], revise: [], drop: [], keep: 0 };
    // 그사이 다른 기기·설정에서 바뀐 값 위에 얹는다
    await updateHeart((h) => { const r = applyFold(h, p, memories, today, folded); record = r.record; return r.heart; });
    const out = { at: new Date().toISOString(), ...record };
    if (!out.add.length && !out.revise.length && !out.drop.length && !out.keep) return null;
    try {
      const log = JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as FoldRecord[];
      localStorage.setItem(LOG_KEY, JSON.stringify([out, ...(Array.isArray(log) ? log : [])].slice(0, LOG_MAX)));
    } catch { /* 기록은 덤 */ }
    return out;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

/** 이 기기의 굳히기 기록(설정의 속마음 칸, 최근 것이 앞) */
export function foldLog(): FoldRecord[] {
  try {
    const v = JSON.parse(localStorage.getItem(LOG_KEY) ?? "[]") as unknown;
    return Array.isArray(v) ? (v as FoldRecord[]) : [];
  } catch {
    return [];
  }
}

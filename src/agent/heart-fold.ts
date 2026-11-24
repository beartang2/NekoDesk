import { memoryApi, settingsApi } from "../api/tauri";
import { walkEnd, type Walk } from "../lib/walk";
import { timeZone } from "../lib/time";
import { useNekoApp } from "../neko/director/stores";
import { followState } from "../neko/presence";
import { budgetBlockReason } from "../stores/claudeBudget";
import { isClaudeActive, nekoNameOf, useSettingsStore } from "../stores/settingsStore";
import { DEFAULT_CHAT_SYSTEM_PROMPT, fetchCompletionMessage } from "./llm-client";
import { heartLines, LINE_MAX, loadHeart, SECRETS_MAX, TRAIT_KINDS, TRAIT_NAME, TRAITS_MAX, updateHeart, unfolded, untoldSecrets, type NekoHeart, type Trait, type TraitKind } from "./neko-heart";
import { activityText, leaksFact, loadMind, mindMaterial } from "./neko-mind";
import type { Memory, OpenAiToolSchema } from "./types";

/**
 * 쉴 때 속마음 굳히기(docs/neko-heart.md §3): 하루 한 번, 굳힌 뒤 쌓인 노트(사건)와 지금 속마음을 보고 네코가 고쳐 쓴다 —
 * 새로 굳은 것(add), 다시 맞는 것(keep), 바뀐 것(revise, 새것이 이긴다), 더는 아닌 것(drop). 속마음이 아니라 알게 된 사실은 기억
 * (memories 종류 neko)으로 보낸다 — 사건에서 온 것은 remember, 이미 속마음에 든 줄은 move(사용자: 기억할 내용이 속마음으로 들어온다).
 * 규칙·예시 없이 재료만 준다. 사용자 사실은 안 보이고(취향만) 글마다 사실 조각을 걸러, 속마음·기억이 산책 주제 재료로 다시 쓰여도
 * 웹으로 새지 않는다. 한 번에 더하기·버리기·옮기기 5개까지 — 웹 글이 섞인 노트가 크게 흔들지 못하게. 옛 키에서 옮겨 온 뒤 첫 번
 * (review)만 옮기기·버리기를 넉넉히 연다(지금 내용 대부분이 기억감이다 — 사용자). 이 지시는 이 호출에만 있다(시스템 프롬프트 그대로)
 */

const FOLD_MS = 30_000;
const STEP_MAX = 5;
/** 한 번 훑기(review)의 옮기기·버리기·기억하기 상한 — 속마음 전부 */
const REVIEW_MAX = TRAITS_MAX;
const LOG_KEY = "neko_heart_log";
const LOG_MAX = 30;

/** 갈래 뜻 한 줄씩(예시 없음 — docs/neko-heart.md §2.1) */
const KIND_DESC = [
  "interest 요즘 마음이 가는 주제나 분야", "culture 알아 가며 즐기게 된 앎과 문화", "philosophy 세상과 삶을 보는 생각",
  "temper 타고난 성질, 버릇, 겁내는 것", "value 소중히 여기는 것과 싫은 것, 스스로 지키는 규칙", "identity 스스로를 어떤 고양이라고 여기는지",
  "secret 사용자에게 아직 말하지 않은 마음",
].join(" · ");
const FOLD_TOOL = {
  type: "function",
  function: {
    name: "heart_fold",
    description: "속마음을 고쳐 쓴다",
    parameters: {
      type: "object",
      properties: {
        add: {
          type: "array",
          description: "새로 굳은 속마음",
          items: {
            type: "object",
            properties: { kind: { type: "string", enum: TRAIT_KINDS, description: KIND_DESC }, text: { type: "string", description: "한 줄" } },
            required: ["kind", "text"],
          },
        },
        keep: { type: "array", items: { type: "string" }, description: "이번 사건들이 다시 뒷받침한 번호" },
        revise: {
          type: "array",
          description: "바뀐 것(새것이 이긴다)",
          items: {
            type: "object",
            properties: { id: { type: "string" }, kind: { type: "string", enum: TRAIT_KINDS }, text: { type: "string", description: "한 줄" } },
            required: ["id", "text"],
          },
        },
        drop: { type: "array", items: { type: "string" }, description: "더는 아닌 번호" },
        remember: { type: "array", items: { type: "string" }, description: "사건 중 속마음이 아니라 기억해 둘 사실·알게 된 것(한 줄씩)" },
        move: { type: "array", items: { type: "string" }, description: "지금 속마음 중 실은 사실·알게 된 것인 번호(기억으로 옮긴다)" },
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
  /** 기억으로 보낸 글(remember·move). 옛 기록엔 없다 */
  remember?: string[];
}

const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: timeZone() });
const line = (v: unknown) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, LINE_MAX) : "");
const isKind = (v: unknown): v is TraitKind => typeof v === "string" && (TRAIT_KINDS as readonly string[]).includes(v);
const newId = () => `t${Math.random().toString(36).slice(2, 8)}`;

/**
 * 모델이 낸 것 → 속마음에 적용한 새 값·기록·기억으로 보낼 글(순수 함수 — 시험한다). 모르는 갈래·빈 글·사실 조각·없는 번호는 버리고,
 * 더하기는 STEP_MAX, 버리기·옮기기·기억하기는 STEP_MAX(훑기 때는 REVIEW_MAX)까지, 상한(속마음 40·안 털어놓은 비밀 5)을 넘는 더하기는
 * 안 받는다. 새 값엔 review 가 없다(훑었다)
 */
export function applyFold(h: NekoHeart, raw: Record<string, unknown> | undefined, memories: Memory[], today: string, folded?: string): { heart: NekoHeart; record: Omit<FoldRecord, "at">; remember: string[] } {
  const byId = new Map(h.traits.map((t) => [t.id, t]));
  const ok = (text: string) => !!text && !leaksFact(text, memories);
  const ids = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).filter((x): x is string => typeof x === "string" && byId.has(x)))];
  const record: Omit<FoldRecord, "at"> = { add: [], revise: [], drop: [], keep: 0 };
  const cap = h.review ? REVIEW_MAX : STEP_MAX;
  const remember: string[] = [];
  let traits: Trait[] = h.traits.map((t) => ({ ...t }));
  const find = (id: string) => traits.find((t) => t.id === id);

  for (const id of ids(raw?.drop).slice(0, cap)) {
    record.drop.push(byId.get(id)!.text);
    traits = traits.filter((t) => t.id !== id);
  }
  for (const id of ids(raw?.move).filter((x) => find(x)).slice(0, cap)) {
    const t = find(id)!;
    traits = traits.filter((x) => x.id !== id);
    if (ok(t.text)) remember.push(t.text);
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
    if (traits.length >= TRAITS_MAX || (r.kind === "secret" && untoldSecrets({ v: 2, traits }).length >= SECRETS_MAX)) continue;
    traits.push({ id: newId(), kind: r.kind, text, since: today, at: today, n: 1 });
    record.add.push(text);
  }
  for (const v of (Array.isArray(raw?.remember) ? raw!.remember : []).slice(0, cap)) {
    const text = line(v);
    if (ok(text) && !remember.includes(text)) remember.push(text);
  }
  if (remember.length) record.remember = remember;
  return { heart: { v: 2, traits, ...(folded ? { folded } : {}), day: today }, record, remember };
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
  const mind = await loadMind(); // 속마음(heart)도 같이 읽는다
  const heart = await loadHeart();
  // 한 번 훑기(review): 굳힌 것과 상관없이 남은 노트 전부를 사건으로 — 그 안의 사실도 기억으로 보내게
  const events = heart.review ? mind.notes : unfolded(mind.notes, heart);
  const review = !!heart.review && heart.traits.length > 0;
  // 하루 한 번만 해 보게 먼저 날을 적는다(실패해도 — 같은 실패로 매번 비용을 쓰지 않게). 훑을 줄이 없으면 훑기 표시도 지운다
  await updateHeart((h) => ({ ...h, day: today, ...(h.traits.length ? {} : { review: undefined }) }));
  if (!events.length && !review) return null;
  const memories = await memoryApi.list().catch((): Memory[] => []);
  const played = await activityText().catch(() => "");
  const name = nekoNameOf(useSettingsStore.getState());
  const persona = useSettingsStore.getState().systemPrompt?.trim() ?? "";
  const me = persona && persona !== DEFAULT_CHAT_SYSTEM_PROMPT.trim() ? persona : "";
  const kinds = TRAIT_KINDS.map((k) => TRAIT_NAME[k]).join("·");
  const ask = [
    `최근 사건들을 보고 네가 어떤 생각을 하는 고양이인지(${kinds}) 고쳐 써. 새로 굳은 것은 add, 다시 맞는 것은 keep, 바뀐 것은 revise, 더는 아닌 것은 drop.`,
    "속마음이 아니라 알게 된 사실은 사건에 있으면 remember, 지금 속마음에 있으면 move.",
    review ? "지금 속마음은 옛 갈래에서 옮겨 온 것이다 — 줄마다 갈래를 바로잡거나(revise) 사실이면 기억으로 옮겨(move)." : "",
  ].filter(Boolean).join(" ");
  const material = [
    // 사용자 사실은 안 보인다(취향만) — 속마음·기억은 산책 주제의 재료로 다시 쓰인다
    ...mindMaterial(mind, memories, { facts: false }).filter((s) => !s.startsWith("## 나는 이런 고양이") && !s.startsWith("## 내 노트")),
    `## 지금 속마음(번호·갈래·글·사건 수)\n${heartLines(heart, { secrets: "all", ids: true }) || "(아직 없음)"}`,
    events.length ? `## 굳힐 사건(노트)\n${events.map((n) => `- ${n.at.slice(0, 10)} ${n.kind}: ${n.text}`).join("\n")}` : "",
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
    const folded = events.length ? events[events.length - 1].at : heart.folded;
    let record: Omit<FoldRecord, "at"> = { add: [], revise: [], drop: [], keep: 0 };
    let remember: string[] = [];
    // 그사이 다른 기기·설정에서 바뀐 값 위에 얹는다
    await updateHeart((h) => { const r = applyFold(h, p, memories, today, folded); record = r.record; remember = r.remember; return r.heart; });
    // 알게 된 사실은 네코의 기억으로(산책 기억과 같은 종류 — 채팅 자동 떠올리기엔 안 나오고 생각하기·산책의 재료가 된다)
    for (const text of remember) await memoryApi.save(text, "neko").catch(() => null);
    const out = { at: new Date().toISOString(), ...record };
    if (!out.add.length && !out.revise.length && !out.drop.length && !out.keep && !remember.length) return null;
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

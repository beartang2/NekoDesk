import { memoryApi, settingsApi } from "../api/tauri";
import { DEFAULT_CHAT_SYSTEM_PROMPT, fetchCompletionMessage } from "./llm-client";
import { nekoNameOf, useSettingsStore } from "../stores/settingsStore";
import { timeZone } from "../lib/time";
import { useNekoNeeds } from "../neko/director/needsStore";
import type { Memory, OpenAiToolSchema } from "./types";

/**
 * 네코의 마음(설계 docs/neko-mind.md). 네코가 자기 손으로 쓰는 짧은 노트와, 느린 선택이 같이 쓰는 생각하기 한 단계.
 *
 * - 노트는 동기화되는 설정 키 neko_mind 한 값이다(맥·폰 같이, 옛 버전은 모르는 키라 버린다). memories 표가 아니라서 채팅 회상에
 *   떠오르지 않고, 웹을 도는 산책 하위 에이전트에도 가지 않는다.
 * - 생각하기(think)는 도구 없이 한 번 부른다. 판단 규칙은 주지 않고 날짜·횟수가 붙은 재료만 준다. 실패·시간 초과면 null —
 *   부르는 쪽은 지금 동작으로 간다.
 * - 생각하기는 사용자 기억을 본다. 그래서 거기서 나온 글(산책 주제·노트)은 사용자 사실(fact·project·reference)에만 있는 글자 조각을
 *   담으면 버린다(leaksFact) — 웹에 심긴 지시가 사용자 이름·장소를 주제에 실어 내보내지 못하게.
 */

export const MIND_KEY = "neko_mind";
export type NoteKind = "wonder" | "want" | "chose";
export interface MindNote {
  /** ISO 시각 */
  at: string;
  kind: NoteKind;
  text: string;
  /** chose 일 때 무엇을 골랐나(walk_topic …) */
  what?: string;
  why?: string;
}
export interface MindTopic { topic: string; at: string[] }
export interface NekoMind { v: 1; notes: MindNote[]; topics: MindTopic[] }

const NOTES_MAX = 40;
const TOPICS_MAX = 30;
const LINE_MAX = 60;
export const TOPIC_MAX = 40;
const THINK_MS = 20_000;

const EMPTY: NekoMind = { v: 1, notes: [], topics: [] };
const line = (v: unknown, max = LINE_MAX) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** 저장된 값을 읽는다. 모르는 칸·망가진 줄은 버린다 */
export function parseMind(raw: string | null): NekoMind {
  let p: unknown;
  try { p = raw ? JSON.parse(raw) : null; } catch { p = null; }
  const o = (p && typeof p === "object" ? p : {}) as { notes?: unknown; topics?: unknown };
  const notes = (Array.isArray(o.notes) ? o.notes : []).flatMap((n): MindNote[] => {
    const r = (n ?? {}) as Record<string, unknown>;
    const kind = r.kind === "wonder" || r.kind === "want" || r.kind === "chose" ? r.kind : null;
    const text = line(r.text), at = typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? r.at : "";
    if (!kind || !text || !at) return [];
    return [{ at, kind, text, ...(line(r.what) ? { what: line(r.what) } : {}), ...(line(r.why) ? { why: line(r.why) } : {}) }];
  });
  const topics = (Array.isArray(o.topics) ? o.topics : []).flatMap((t): MindTopic[] => {
    const r = (t ?? {}) as Record<string, unknown>;
    const topic = line(r.topic, TOPIC_MAX), at = (Array.isArray(r.at) ? r.at : []).filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d));
    return topic && at.length ? [{ topic, at }] : [];
  });
  return { v: 1, notes: notes.slice(-NOTES_MAX), topics: topics.slice(-TOPICS_MAX) };
}

export async function loadMind(): Promise<NekoMind> {
  return parseMind(await settingsApi.get(MIND_KEY).catch(() => null));
}

/** 지금 저장된 값(다른 기기에서 받아 온 것 포함)을 읽어 고친 뒤 쓴다 */
export async function updateMind(fn: (m: NekoMind) => NekoMind): Promise<NekoMind> {
  const next = fn(await loadMind());
  const out: NekoMind = { v: 1, notes: next.notes.slice(-NOTES_MAX), topics: next.topics.slice(-TOPICS_MAX) };
  await settingsApi.set(MIND_KEY, JSON.stringify(out)).catch(() => {});
  return out;
}

/** 설정에서 노트 하나 지우기(at·글이 같은 것) */
export function forgetNote(n: MindNote): Promise<NekoMind> {
  return updateMind((m) => ({ ...m, notes: m.notes.filter((x) => !(x.at === n.at && x.text === n.text)) }));
}

// ── 사용자 사실 새는지 ────────────────────────────────────────────────────────

const compact = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
function grams(s: string, out = new Set<string>()): Set<string> {
  const t = compact(s);
  for (let i = 0; i + 3 <= t.length; i++) out.add(t.slice(i, i + 3));
  return out;
}
const USER_FACT = new Set(["fact", "project", "reference"]);

/**
 * 글이 사용자 사실(fact·project·reference 기억)에만 있는 세 글자 조각을 담고 있나. 네코 자신의 재료(산책 기억·노트·주제)와
 * 사용자 취향(preference)에도 있는 조각은 넘어간다 — 관심사를 이어 가는 건 이 기능의 목적이다. 이름·주소·일정 같은 건
 * 사실에만 있어 걸린다. 걸리면 그 글을 버리고 지금 동작으로 간다
 */
export function leaksFact(text: string, memories: Memory[], own: string[] = []): boolean {
  const facts = memories.filter((m) => USER_FACT.has(m.kind));
  if (!facts.length || !text) return false;
  const factG = new Set<string>(), ownG = new Set<string>();
  for (const m of facts) grams(m.content, factG);
  for (const m of memories) if (!USER_FACT.has(m.kind)) grams(m.content, ownG);
  for (const s of own) grams(s, ownG);
  for (const g of grams(text)) if (factG.has(g) && !ownG.has(g)) return true;
  return false;
}

// ── 재료 ─────────────────────────────────────────────────────────────────────

const ymd = (d: Date) => d.toLocaleDateString("en-CA", { timeZone: timeZone() });
const md = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : `${d.getMonth() + 1}/${d.getDate()}`; };
const dayPart = (h: number) => (h < 6 ? "새벽" : h < 11 ? "아침" : h < 14 ? "점심 무렵" : h < 18 ? "오후" : h < 21 ? "저녁" : "밤");
const KIND_NAME: Record<NoteKind, string> = { wonder: "궁금", want: "하고 싶음", chose: "고름" };
const WHAT_NAME: Record<string, string> = { walk_topic: "산책 주제" };
function section(title: string, body: string): string {
  return body ? `## ${title}\n${body}` : "";
}

/** 생각하기 재료 덩이들(§6). 사용자 기억은 취향 위주로 12개까지 */
export function mindMaterial(mind: NekoMind, memories: Memory[], now = new Date()): string[] {
  const n = useNekoNeeds.getState().needs;
  const wd = now.toLocaleDateString("ko-KR", { weekday: "long", timeZone: timeZone() });
  const hour = Number(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: timeZone() })) % 24;
  const nowText = `${ymd(now)} ${wd} ${dayPart(hour)}\n기운 ${Math.round(n.energy)} · 호기심 ${Math.round(n.curiosity)} · 청결 ${Math.round(n.clean)} · 애정 ${Math.round(n.affection)} (0–100)`;
  const notes = mind.notes.slice(-20).map((x) =>
    `- ${md(x.at)} ${KIND_NAME[x.kind]}${x.what ? `(${WHAT_NAME[x.what] ?? x.what})` : ""}: ${x.text}${x.why ? ` — ${x.why}` : ""}`).join("\n");
  const topics = mind.topics.map((t) => `- ${t.topic} — ${t.at.length}번: ${t.at.map((d) => md(d)).join(", ")}`).join("\n");
  const walked = memories.filter((m) => m.kind === "neko").slice(0, 12)
    .map((m) => `- (${md(m.created_at)}, 떠올림 ${m.use_count ?? 0}번) ${m.content}`).join("\n");
  const user = [...memories.filter((m) => m.kind === "preference"), ...memories.filter((m) => m.kind !== "preference" && m.kind !== "neko")]
    .slice(0, 12).map((m) => `- (${md(m.created_at)}) ${m.content}`).join("\n");
  return [
    section("지금", nowText),
    section("내 노트", notes),
    section("내가 알아본 주제", topics),
    section("산책에서 알게 된 것", walked),
    section("사용자에 대해 아는 것", user),
  ].filter(Boolean);
}

// ── 생각하기 ─────────────────────────────────────────────────────────────────

const THINK_TOOL = {
  type: "function",
  function: {
    name: "neko_think",
    description: "고른 것과 까닭을 낸다",
    parameters: {
      type: "object",
      properties: {
        pick: { type: "string", description: "고른 것" },
        why: { type: "string", description: "고른 까닭 한 줄" },
        note: {
          type: "object",
          description: "요즘 궁금한 것(wonder)이나 하고 싶은 것(want) 한 줄. 없으면 빼",
          properties: { kind: { type: "string", enum: ["wonder", "want"] }, text: { type: "string" } },
          required: ["kind", "text"],
        },
      },
      required: ["pick", "why"],
    },
  },
} as OpenAiToolSchema;

export interface Thought { pick: string; why: string; note?: { kind: "wonder" | "want"; text: string } }

function persona(): string {
  const p = useSettingsStore.getState().systemPrompt?.trim() ?? "";
  return p && p !== DEFAULT_CHAT_SYSTEM_PROMPT.trim() ? p : "";
}

/**
 * 생각하기 한 번. ask = 이번에 고를 것(한 줄), material = 재료 덩이들. 도구 없이 neko_think 로 답하게 한다.
 * 20초 안에 답이 없거나 툴을 안 부르거나 고른 게 비면 null(지금 동작으로)
 */
export async function think(ask: string, material: string[], signal?: AbortSignal, ms = THINK_MS): Promise<Thought | null> {
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  const timer = setTimeout(stop, ms);
  signal?.addEventListener("abort", stop, { once: true });
  try {
    const name = nekoNameOf(useSettingsStore.getState()), me = persona();
    const turn = await fetchCompletionMessage(
      [
        { role: "system", content: [`너는 고양이 ${name}. neko_think 툴로 답해.`, me && `네 성격과 말투:\n${me}`].filter(Boolean).join("\n\n") },
        { role: "user", content: [...material, `## 고를 것\n${ask}`].join("\n\n") },
      ],
      { tools: [THINK_TOOL] },
      undefined,
      ctrl.signal,
    );
    if (ctrl.signal.aborted) return null;
    const p = turn.toolCalls.find((c) => c.name === "neko_think")?.params;
    const pick = line(p?.pick), why = line(p?.why);
    if (!pick) return null;
    const nr = (p?.note ?? null) as { kind?: unknown; text?: unknown } | null;
    const kind: "wonder" | "want" | null = nr?.kind === "wonder" ? "wonder" : nr?.kind === "want" ? "want" : null;
    const note = kind && line(nr?.text) ? { kind, text: line(nr?.text) } : undefined;
    return { pick, why, ...(note ? { note } : {}) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
}

// ── 1단계: 산책 주제 ──────────────────────────────────────────────────────────

const ownText = (m: NekoMind) => [...m.notes.map((n) => n.text), ...m.topics.map((t) => t.topic)];

/**
 * 이번 산책에서 알아볼 주제 한 줄(TOPIC_MAX 자). 재료는 노트·알아본 주제(횟수·날짜)·산책 기억·사용자 기억이고, 고르는 건 네코다.
 * 주제가 사용자 사실을 담거나 생각하기가 안 되면 null — 하위 에이전트가 지금처럼 스스로 고른다. 고른 주제와 까닭, 따라 나온
 * 궁금한 것은 노트에 남긴다
 */
export async function chooseWalkTopic(memories: Memory[], signal?: AbortSignal): Promise<string | null> {
  const mind = await loadMind();
  const t = await think(`이번 산책에서 알아볼 주제 하나(${TOPIC_MAX}자 안)`, mindMaterial(mind, memories), signal);
  if (!t || signal?.aborted) return null;
  const topic = t.pick.slice(0, TOPIC_MAX), own = ownText(mind);
  if (leaksFact(topic, memories, own)) return null;
  const at = new Date().toISOString(), day = ymd(new Date());
  await updateMind((m) => {
    const topics = m.topics.filter((x) => x.topic !== topic);
    const prev = m.topics.find((x) => x.topic === topic);
    const notes: MindNote[] = [...m.notes, { at, kind: "chose", what: "walk_topic", text: topic, ...(t.why && !leaksFact(t.why, memories, own) ? { why: t.why } : {}) }];
    if (t.note && !leaksFact(t.note.text, memories, own)) notes.push({ at, kind: t.note.kind, text: t.note.text });
    return { ...m, notes, topics: [...topics, { topic, at: [...(prev?.at ?? []).filter((d) => d !== day), day] }] };
  });
  return topic;
}

/** 산책 보고의 '다음에 궁금한 것' 한 줄을 노트로(사용자 사실이 섞였으면 버린다) */
export async function noteWonder(text: string, memories?: Memory[]): Promise<void> {
  const t = line(text);
  if (!t) return;
  const mems = memories ?? (await memoryApi.list().catch((): Memory[] => []));
  const mind = await loadMind();
  if (leaksFact(t, mems, ownText(mind))) return;
  await updateMind((m) => ({ ...m, notes: [...m.notes, { at: new Date().toISOString(), kind: "wonder", text: t }] }));
}

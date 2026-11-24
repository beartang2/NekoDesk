import { settingsApi } from "../api/tauri";
import { heartLines, heartNow, loadHeart, untoldSecrets } from "../agent/neko-heart";
import { timeZone } from "../lib/time";
import { walkEnd, walkStart, type Walk } from "../lib/walk";
import { useNekoApp } from "./director/stores";
import { PLACE_NAME } from "./gifts";
import { useNekoStore } from "./nekoStore";
import { bigState } from "./presence";
import { coatSwatch, summarizeAppearance } from "./summarize";

/**
 * 네코가 제 상태를 안다(0.1.28, 사용자: 지금 제 모습·색을 확인할 수 있게, 하는 일을 스스로 알게).
 *
 * - 최근 행동 기록: 엔진 상태 글자(label)가 바뀔 때 시각과 함께 이 기기에만 남긴다(localStorage, 6시간). 걷기·쉬기처럼
 *   몇 초씩 오가는 것은 안 남고, MIN_MS 넘게 이어진 것만 시작·끝과 함께 남는다. 산책은 산책 기록(neko_walk)에서, 꿈은
 *   마음 노트에서 읽을 때 이어 붙인다.
 * - selfStateText: 내부 도구 neko.self 의 결과. 모습·색, 자리, 지금 하는 일, 게이지, 잠·산책, 최근 기록.
 * - recentDoings: 돌아온 사용자에게 건넬 첫마디의 재료(neko-mind restThink). 꺼낼지 말지는 네코가 정한다.
 */

const KEY = "neko_self_log";
export const SELF_LOG_MS = 6 * 3_600_000;
/** 이만큼 이어진 상태만 남긴다 — 돌아다니며 몇 초씩 바뀌는 쉬기·걷기는 기록이 아니다 */
export const MIN_MS = 20_000;
const MAX = 200;
/** 같은 상태가 이만큼 안에 다시 오면 한 줄로 잇는다 */
const JOIN_MS = 60_000;

export interface SelfEntry { at: number; end: number; label: string }

let cur: { label: string; at: number } | null = null;

function read(): SelfEntry[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]") as SelfEntry[];
    return Array.isArray(v) ? v.filter((e) => typeof e?.label === "string" && Number.isFinite(e.at) && Number.isFinite(e.end)) : [];
  } catch {
    return [];
  }
}
function write(list: SelfEntry[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* 기록은 덤이다 */ }
}

/** 엔진 상태 글자가 바뀌었다(감독이 엔진 label 이벤트로 부른다) */
export function noteLabel(label: string, now = Date.now()): void {
  if (cur?.label === label) return;
  if (cur && now - cur.at >= MIN_MS) {
    const list = read().filter((e) => e.end > now - SELF_LOG_MS);
    const last = list[list.length - 1];
    if (last && last.label === cur.label && cur.at - last.end < JOIN_MS) last.end = now;
    else list.push({ at: cur.at, end: now, label: cur.label });
    write(list.slice(-MAX));
  }
  cur = { label, at: now };
}

/** 한순간의 일(네코가 직접 고른 행동 — neko/nekoAct). 시작·끝이 같은 줄로 남는다 */
export function noteMoment(label: string, now = Date.now()): void {
  const list = read().filter((e) => e.end > now - SELF_LOG_MS);
  list.push({ at: now, end: now, label });
  write(list.slice(-MAX));
}

const hm = (t: number) => new Date(t).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: timeZone() });

async function lastWalk(): Promise<Walk | null> {
  try {
    const w = JSON.parse((await settingsApi.get("neko_walk").catch(() => null)) ?? "null") as Walk | null;
    return w?.path?.length ? w : null;
  } catch {
    return null;
  }
}

async function dreams(since: number): Promise<{ at: number; text: string }[]> {
  // neko-mind 는 llm-client 를 거쳐 도구 표를 불러온다 — 도구 표가 이 모듈을 부르니 고리가 안 생기게 쓸 때 불러온다
  const { loadMind } = await import("../agent/neko-mind");
  const m = await loadMind().catch(() => null);
  return (m?.notes ?? []).filter((n) => n.kind === "dream").map((n) => ({ at: Date.parse(n.at), text: n.text })).filter((d) => d.at >= since);
}

/** 최근 몇 시간 한 일(오래된 것부터 한 줄씩). 지금 하는 것은 끝 시각 없이 */
export async function recentDoings(now = Date.now()): Promise<string> {
  const since = now - SELF_LOG_MS;
  const rows: { at: number; line: string }[] = read().filter((e) => e.end > since)
    .map((e) => ({ at: e.at, line: e.end === e.at ? `- ${hm(e.at)} ${e.label}` : `- ${hm(e.at)}–${hm(e.end)} ${e.label}` }));
  const w = await lastWalk();
  if (w && walkStart(w) > since && walkStart(w) <= now) {
    rows.push({ at: walkStart(w), line: `- ${hm(walkStart(w))}–${walkEnd(w) > now ? "" : hm(walkEnd(w))} 산책${w.done ? "" : "(아직 다녀오는 중)"}` });
  }
  for (const d of await dreams(since)) rows.push({ at: d.at, line: `- ${hm(d.at)} 꿈: ${d.text}` });
  if (cur && now - cur.at >= MIN_MS) rows.push({ at: cur.at, line: `- ${hm(cur.at)}– ${cur.label}(지금)` });
  return rows.sort((a, b) => a.at - b.at).map((r) => r.line).join("\n");
}

const EAR = { pointy: "뾰족한 귀", round: "동그란 귀", fold: "접힌 귀" } as const;
const TAIL = { long: "평범한 꼬리", fluffy: "복슬 꼬리", bob: "짧은 꼬리" } as const;
const LEGS = { short: "짧은 다리", normal: "평범한 다리", long: "긴 다리" } as const;
const BIG = { awake: "깨어 있음", sleep: "졸거나 자는 중", walk: "산책 중", eat: "밥 먹는 중" } as const;

/** 내부 도구 neko.self 의 결과: 지금 네 모습·자리·하는 일과 최근 기록 */
export async function selfStateText(now = Date.now()): Promise<string> {
  const { appearance: a, stage } = useNekoStore.getState();
  const app = useNekoApp.getState();
  const doing = cur?.label ?? "알 수 없음";
  const recent = await recentDoings(now);
  const heart = await loadHeart().catch(() => heartNow());
  const untold = untoldSecrets(heart).length;
  return [
    `모습: ${summarizeAppearance(a)} · ${EAR[a.ear]} · ${TAIL[a.tail]} · ${LEGS[a.legs]} · 말랑함 ${Math.round(a.soft * 100)}/100 · 털 색 ${coatSwatch(a)}`,
    `있는 곳: ${PLACE_NAME[stage.placement]}${app.screenHidden ? "(사용자가 숨겨 둠)" : ""}`,
    `지금: ${doing}`,
    `상태: ${BIG[bigState()]}`,
    `최근 ${SELF_LOG_MS / 3_600_000}시간 한 일:\n${recent || "- 기록 없음"}`,
    // 성격(docs/neko-heart.md §5): 사건 수 많은 순 12개, 털어놓은 비밀까지. 아직 말 안 한 비밀은 수만 — 내용은 첫마디로 털어놓을 때까지 모른다
    `내 성격:\n${heartLines(heart, { secrets: "told", max: 12 }) || "- 아직 굳은 것 없음"}`,
    ...(untold ? [`아직 말하지 않은 비밀: ${untold}개(내용은 지금 떠오르지 않는다)`] : []),
    // 직접 고를 수 있는 행동(neko.act) — 이 자리에서 지금 되는 것만. 도구 표와 고리가 생기지 않게 쓸 때 불러온다
    `지금 할 수 있는 행동(neko.act): ${(await import("./nekoAct")).actOptionsText()}`,
  ].join("\n");
}

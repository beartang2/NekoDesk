import { settingsApi, syncApi } from "../api/tauri";
import { appEvents } from "../lib/events";
import { useNekoApp } from "./director/stores";
import { setFollowing } from "./lead";

/**
 * 네코의 큰 상태를 맥·폰이 맞춘다(사용자: "한쪽은 자고 있고 한쪽은 다른 활동 중", 고른 방식은 큰 상태만 — 0.1.22).
 *
 * 큰 상태 = 깨어 있음·자는 중·산책 중·밥 먹는 중. 깨어 있을 때의 세부 놀이(털실·상자…)는 기기마다 다르다.
 * 가장 최근에 사용자가 쓴 기기(앞에 띄우고 만진 기기)의 큰 상태를 다른 기기가 따른다 — 동네(lib/here.ts)와 같은 '최근 기기' 방식.
 * 동기화 설정 neko_presence 에 { state, at, used, device } 하나를 덮어쓴다. 쓰는 때는 둘뿐이다: 앞 기기의 큰 상태가 바뀔 때,
 * 다른 기기가 앞이던 중에 이 기기를 쓰기 시작해 이 기기가 앞이 될 때. 옛 버전은 모르는 키라 버린다.
 *
 * 따르는 쪽은 감독(useNekoDirector)이 읽는다 — 자면 앞 기기가 마지막으로 쓰인 때부터 똑같이 졸다 깊이 자고, 깨어 있으면 졸지 않고,
 * 밥 먹으면 밥을 먹는다. 바꾸는 건 감독의 계획이라 하던 활동이 끝나고 자세가 바뀌는 길 그대로다(순간이동 없음).
 * 산책은 산책 나눠 쓰기(walkClaim·neko_walk_view)가 이미 맞춘다.
 */
export const PRESENCE_KEY = "neko_presence";
export type BigState = "awake" | "sleep" | "walk" | "eat";
/** used = 그 기기 사용자가 마지막으로 앱을 쓴 때(epoch ms), at = 적은 때 */
export interface Presence { state: BigState; at: number; used: number; device: string }

const STATES = new Set<BigState>(["awake", "sleep", "walk", "eat"]);
/** 이보다 오래된 기록은 안 따른다(앞 기기가 꺼진 채 하루가 지남) */
const STALE_MS = 12 * 3_600_000;

let shared: Presence | null = null;
let me = "";
let local: BigState = "awake";
const subs = new Set<() => void>();
// 숨은 게이지(director/needsStore)도 앞 기기 것을 따른다 — 앞·뒤를 neko/lead 에 알린다
const changed = () => { setFollowing(otherLeads()); subs.forEach((f) => f()); };

/** 이 기기 사용자가 마지막으로 앱을 쓴 때(epoch). 감독의 lastActiveAt 은 performance 시계라 바꾼다 */
export const usedAtNow = (): number => Date.now() - (performance.now() - useNekoApp.getState().lastActiveAt);
/** epoch → performance 시계(감독 입력용) */
export const perfOf = (epoch: number): number => performance.now() - (Date.now() - epoch);

export function parsePresence(raw: string | null): Presence | null {
  try {
    const p = raw ? (JSON.parse(raw) as Partial<Presence>) : null;
    if (!p || !STATES.has(p.state as BigState) || !Number.isFinite(p.at) || !Number.isFinite(p.used) || typeof p.device !== "string") return null;
    return { state: p.state as BigState, at: p.at!, used: p.used!, device: p.device };
  } catch {
    return null;
  }
}

async function read(): Promise<void> {
  shared = parsePresence(await settingsApi.get(PRESENCE_KEY).catch(() => null));
  changed();
}

function write(state: BigState): void {
  const v: Presence = { state, at: Date.now(), used: usedAtNow(), device: me };
  shared = v;
  changed();
  void settingsApi.set(PRESENCE_KEY, JSON.stringify(v)).catch(() => {});
}

/** 다른 기기가 앞이다: 그 기기가 이 기기보다 나중에 쓰였다 */
const otherLeads = (): boolean => !!shared && shared.device !== me && shared.used > usedAtNow() && Date.now() - shared.at < STALE_MS;

/**
 * 이 기기의 큰 상태가 바뀌었다(App). 이 기기가 앞이면(가장 최근에 쓰였으면) 적는다 — 바뀔 때만. 다른 기기가 앞이면 따르기만
 */
export function reportBigState(state: BigState): void {
  local = state;
  if (otherLeads()) return;
  if (shared && shared.device === me && shared.state === state) return;
  write(state);
}

/** 따를 큰 상태: 다른 기기가 앞이면 그 기기의 상태, 아니면 null(이 기기 그대로) */
export function followState(): BigState | null {
  return otherLeads() ? shared!.state : null;
}
/** 지금 큰 상태: 다른 기기가 앞이면 그 기기 것, 아니면 이 기기 것(네코 제 상태 보기 — neko/selfState) */
export const bigState = (): BigState => followState() ?? local;
/** 따르는 중이면 앞 기기가 마지막으로 쓰인 때와 지금 상태를 적은 때(epoch) */
export const leaderUsedAt = (): number | null => (otherLeads() ? shared!.used : null);
export const leaderStateAt = (): number | null => (otherLeads() ? shared!.at : null);

export function onPresence(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}

/**
 * 메인 창에서 한 번(App). 기기 이름(동기화 device)을 받고, 다른 기기가 적은 걸 읽는다. 다른 기기가 앞이던 중에 이 기기를 쓰기
 * 시작하면(앱을 만짐) 이 기기가 앞이 된다 — 그때 한 번 적는다(막 만졌으니 자고 있었으면 깬 것으로)
 */
export function watchPresence(): () => void {
  void syncApi.status().then((s) => { me = s.device ?? ""; }, () => {}).then(read);
  const offs = [
    appEvents.on("syncChanged", ({ colls }) => { if (colls.includes("setting")) void read(); }),
    useNekoApp.subscribe((s, p) => {
      if (s.lastActiveAt === p.lastActiveAt || !shared || shared.device === me) return;
      if (usedAtNow() > shared.used) write(local === "sleep" ? "awake" : local);
    }),
  ];
  return () => offs.forEach((f) => f());
}

/** 시험용 */
export function resetPresence(device = "", value: Presence | null = null): void { me = device; shared = value; local = "awake"; setFollowing(otherLeads()); }

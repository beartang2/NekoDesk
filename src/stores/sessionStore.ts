import { create } from "zustand";
import { conversationApi, sessionApi, type SessionRow } from "../api/tauri";

/**
 * 세션(대화) 목록 + 활성 세션 스토어.
 *
 * 예전엔 App.tsx 가 sessions/activeId 를 useState 로 들고, restoreState()·
 * INITIAL_STATE·영속화 useEffect 2개까지 직접 관리했다. 세션은 사이드바·채팅·
 * 브리핑 등 여러 곳이 읽는 교차 상태라 스토어가 맞다.
 *
 * localStorage 는 기존 키/포맷(sessions=JSON 배열, activeId=raw 문자열)을 그대로
 * 읽고 써서 데이터 마이그레이션이 없다. 영속화는 액션 안에서 처리한다(예전 useEffect 대체).
 *
 * 동기화(docs/neko-sync.md §2.6): 목록·수동 요약의 원본은 DB sessions 표다. localStorage 는 켤 때 바로 그리는
 * 캐시로 남고, hydrateSessions 가 DB 값으로 덮는다(처음 한 번은 localStorage 를 DB 로 옮긴다).
 * setSessions 는 앞뒤를 견줘 새로 생기거나 제목이 바뀐 세션만 DB 에 적는다 — 호출부는 그대로다. 목록에서 빠졌다고
 * 지우지 않는다: 낡은 목록(다른 기기에서 막 온 세션을 모르는)으로 덮으면 그 세션이 사용자가 지운 것으로 올라가
 * 모든 기기에서 사라진다. DB 에서 지우는 건 사용자가 지울 때(removeSession)와 자동 삭제(백엔드)뿐이다.
 */

export interface Session {
  id: string;
  title: string;
  date: string;
  /** 만든 때(ms). 목록 순서(새 것이 위). 예전 캐시엔 없다 */
  createdAt?: number;
  /** 수동 요약(상단 요약 바). 예전엔 localStorage nekodesk_compact_<id> */
  summary?: string;
}

const SESSIONS_KEY = "nekodesk_sessions";
const ACTIVE_SESSION_KEY = "nekodesk_active_session";

export function makeSession(): Session {
  return { id: crypto.randomUUID(), title: "새 대화", date: "방금", createdAt: Date.now() };
}

function restore(): { sessions: Session[]; activeId: string } {
  let sessions: Session[];
  try {
    const saved = localStorage.getItem(SESSIONS_KEY);
    const parsed = saved ? (JSON.parse(saved) as Session[]) : null;
    sessions = parsed && parsed.length > 0 ? parsed : [makeSession()];
  } catch {
    sessions = [makeSession()];
  }
  const savedActiveId = localStorage.getItem(ACTIVE_SESSION_KEY);
  const activeId =
    savedActiveId && sessions.some((s) => s.id === savedActiveId)
      ? savedActiveId
      : sessions[0].id;
  return { sessions, activeId };
}

type SessionsUpdater = Session[] | ((prev: Session[]) => Session[]);

interface SessionStore {
  sessions: Session[];
  activeId: string;
  setActiveId: (id: string) => void;
  /** 값 또는 (prev) => next 함수 둘 다 받는다(기존 setSessions 호출부 그대로 동작). */
  setSessions: (updater: SessionsUpdater) => void;
  /** 수동 요약을 적고 그 세션의 DB 메시지를 지운다 */
  compact: (id: string, summary: string) => Promise<void>;
}

const COMPACT_KEY = (id: string) => `nekodesk_compact_${id}`;

/** 새 세션·바뀐 제목을 DB 에 적는다. 실패해도 화면은 그대로 — 다음 hydrate 때 맞는다 */
function persistDiff(prev: Session[], next: Session[]) {
  const before = new Map(prev.map((s) => [s.id, s]));
  for (const s of next) {
    const p = before.get(s.id);
    if (!p || p.title !== s.title) void sessionApi.put(s.id, s.title, s.createdAt ?? Date.now()).catch(() => {});
  }
}

/** 사용자가 지운 세션: 메시지·요약과 함께 DB 에서 지운다(다른 기기에서도 지워진다). 목록에서 빼는 건 부른 쪽이 */
export const removeSession = (id: string) => sessionApi.delete(id);

const initial = restore();

export const useSessionStore = create<SessionStore>((set, get) => ({
  sessions: initial.sessions,
  activeId: initial.activeId,
  setActiveId: (id) => {
    localStorage.setItem(ACTIVE_SESSION_KEY, id);
    set({ activeId: id });
  },
  setSessions: (updater) => {
    const next = typeof updater === "function" ? updater(get().sessions) : updater;
    const prev = get().sessions;
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(next));
    set({ sessions: next });
    persistDiff(prev, next);
  },
  compact: async (id, summary) => {
    const sessions = get().sessions.map((s) => (s.id === id ? { ...s, summary } : s));
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    set({ sessions });
    await sessionApi.compact(id, summary);
  },
}));

const dateOf = (ms: number) => new Date(ms).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });

/** DB 목록으로 화면을 맞춘다(DB 에 바로 다시 적지 않는다). 지금 열린 세션이 사라졌으면 맨 위로, 다 없으면 새 대화 */
function applyRows(rows: SessionRow[]) {
  const { sessions: prev, activeId } = useSessionStore.getState();
  const old = new Map(prev.map((s) => [s.id, s]));
  let sessions: Session[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    date: old.get(r.id)?.date ?? dateOf(r.created_at),
    createdAt: r.created_at,
    ...(r.summary ? { summary: r.summary } : {}),
  }));
  if (!sessions.length) {
    const fresh = makeSession();
    sessions = [fresh];
    void sessionApi.put(fresh.id, fresh.title, fresh.createdAt!).catch(() => {});
  }
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  useSessionStore.setState({ sessions });
  if (!sessions.some((s) => s.id === activeId)) useSessionStore.getState().setActiveId(sessions[0].id);
}

const IMPORTED_KEY = "nekodesk_sessions_in_db";

/**
 * 켤 때와 다른 기기에서 바뀐 게 왔을 때(sync-changed) DB 목록을 읽어 덮는다. 이 기기에서 처음이면 지금 목록과
 * localStorage 의 수동 요약을 먼저 옮긴다(이미 있는 세션은 그대로) — 순서는 만든 때로 지키니 예전 것은 지금보다
 * 조금씩 이르게 적는다. "DB 가 비었나"로 고르지 않는다: 켜자마자 새 대화 하나가 먼저 적히면 나머지를 잃는다.
 */
export async function hydrateSessions(now = Date.now()): Promise<void> {
  if (!localStorage.getItem(IMPORTED_KEY)) {
    const local = useSessionStore.getState().sessions;
    await sessionApi.import(local.map((s, i) => ({
      id: s.id,
      title: s.title,
      created_at: s.createdAt ?? now - i,
      summary: s.summary ?? localStorage.getItem(COMPACT_KEY(s.id)),
    })));
    localStorage.setItem(IMPORTED_KEY, "1");
  }
  applyRows(await sessionApi.list());
}

const PRUNE_FROM_KEY = "nekodesk_session_prune_from";
const DAY_MS = 86_400_000;

/**
 * 마지막으로 쓴 지 days 일 지난 세션을 지운다(설정 › 오래된 대화). 메인 창이 켤 때 한 번 부른다.
 * DB 대화·탭·자동 요약을 같이 지우고, 지금 열린 세션과 메시지가 없는 세션(언제 썼는지 모름)은 남긴다.
 * 기억(memories)은 건드리지 않는다. 처음 부른 날부터 days 일 동안은 아무것도 지우지 않는다 — 업데이트하자마자
 * 옛 대화가 한꺼번에 사라지지 않게. 지운 세션 id 를 돌려준다.
 */
export async function pruneOldSessions(days: number, now = Date.now()): Promise<string[]> {
  if (!days) return [];
  let from = Number(localStorage.getItem(PRUNE_FROM_KEY));
  if (!from) localStorage.setItem(PRUNE_FROM_KEY, String((from = now)));
  if (now - from < days * DAY_MS) return [];
  const gone = await conversationApi.prune(days, [useSessionStore.getState().activeId]);
  if (!gone.length) return gone;
  const set = new Set(gone);
  gone.forEach((id) => localStorage.removeItem(COMPACT_KEY(id)));
  useSessionStore.getState().setSessions((prev) => {
    const left = prev.filter((s) => !set.has(s.id));
    return left.length ? left : prev;
  });
  return gone;
}

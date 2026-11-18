import { create } from "zustand";
import { conversationApi } from "../api/tauri";

/**
 * 세션(대화) 목록 + 활성 세션 스토어.
 *
 * 예전엔 App.tsx 가 sessions/activeId 를 useState 로 들고, restoreState()·
 * INITIAL_STATE·영속화 useEffect 2개까지 직접 관리했다. 세션은 사이드바·채팅·
 * 브리핑 등 여러 곳이 읽는 교차 상태라 스토어가 맞다.
 *
 * localStorage 는 기존 키/포맷(sessions=JSON 배열, activeId=raw 문자열)을 그대로
 * 읽고 써서 데이터 마이그레이션이 없다. 영속화는 액션 안에서 처리한다(예전 useEffect 대체).
 */

export interface Session {
  id: string;
  title: string;
  date: string;
}

const SESSIONS_KEY = "nekodesk_sessions";
const ACTIVE_SESSION_KEY = "nekodesk_active_session";

export function makeSession(): Session {
  return { id: crypto.randomUUID(), title: "새 대화", date: "방금" };
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
}

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
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(next));
    set({ sessions: next });
  },
}));

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
  gone.forEach((id) => localStorage.removeItem(`nekodesk_compact_${id}`));
  useSessionStore.getState().setSessions((prev) => {
    const left = prev.filter((s) => !set.has(s.id));
    return left.length ? left : prev;
  });
  return gone;
}

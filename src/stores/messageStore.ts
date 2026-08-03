import { create } from "zustand";
import type { Dispatch, SetStateAction } from "react";
import type { ChatMessage } from "../hooks/useAgentLoop";

/**
 * 세션별 채팅 메시지 스토어.
 *
 * 예전엔 App.tsx 가 allMessages 를 useState 로 들고, 비동기 에이전트 루프가
 * 최신 값을 읽으려고 allMessagesRef 미러링 해킹을 썼다(useAgentPool 파라미터로
 * ref + setter 전달). zustand 는 useMessageStore.getState() 로 항상 최신을 주므로
 * ref 해킹이 사라진다. App 은 messages 를 구독해 렌더, 에이전트 루프는 getState 로 읽고 쓴다.
 */

type MessagesMap = Record<string, ChatMessage[]>;

interface MessageStore {
  messages: MessagesMap;
  /** 세션 메시지 읽기 (없으면 빈 배열). 비동기 루프에서 최신값 read. */
  get: (sessionId: string) => ChatMessage[];
  /** 한 세션 메시지 갱신. 값 또는 (prev) => next. (기존 patchSessionMessages 대체) */
  patch: (sessionId: string, action: SetStateAction<ChatMessage[]>) => void;
  /** 전체 맵 갱신. 값 또는 (prev) => next. (기존 setAllMessages 대체) */
  setAll: Dispatch<SetStateAction<MessagesMap>>;
}

export const useMessageStore = create<MessageStore>((set, storeGet) => ({
  messages: {},
  get: (sessionId) => storeGet().messages[sessionId] ?? [],
  patch: (sessionId, action) =>
    set((state) => {
      const current = state.messages[sessionId] ?? [];
      const next = typeof action === "function" ? action(current) : action;
      return { messages: { ...state.messages, [sessionId]: next } };
    }),
  setAll: (updater) =>
    set((state) => ({
      messages: typeof updater === "function" ? updater(state.messages) : updater,
    })),
}));

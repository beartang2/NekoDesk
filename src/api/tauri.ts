/**
 * Tauri IPC 경계.
 *
 * 컴포넌트가 `invoke<Todo[]>("todo_list")` 처럼 문자열 커맨드명 + 손으로 맞춘
 * 인자/제네릭을 직접 쓰던 것을 대체한다. 커맨드명·인자 형태·반환 타입을
 * 여기 한 곳에서만 안다 → 백엔드 시그니처가 바뀌면 여기만 고치면 되고,
 * 오타난 커맨드명이나 잘못된 인자 키는 컴파일 타임에 잡힌다.
 *
 * (이 슬라이스에서는 todos 만 옮겼다. 나머지 도메인도 같은 패턴으로 추가한다.)
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  Todo,
  ScheduleEvent,
  ConversationMessage,
  ExecHistoryItem,
} from "../agent/types";

export const todosApi = {
  /** 열린 할 일 (마감 임박순). */
  list: () => invoke<Todo[]>("todo_list"),

  /** 완료된 할 일 (최근 완료순). */
  listDone: () => invoke<Todo[]>("todo_list_done"),

  /** 추가하고 생성된 항목을 반환. */
  add: (content: string, dueAt: string | null = null) =>
    invoke<Todo>("todo_add", { content, dueAt }),

  /** 완료 처리. 실제로 바뀐 항목이 있으면 true. */
  complete: (id: number) => invoke<boolean>("todo_complete", { id }),
};

export type ScheduleRange = "today" | "week" | "all";

export const scheduleApi = {
  list: (range: ScheduleRange = "all") =>
    invoke<ScheduleEvent[]>("schedule_list", { range }),
  add: (title: string, startAt: string, endAt: string | null = null) =>
    invoke<ScheduleEvent>("schedule_add", { title, startAt, endAt }),
  /** 삭제된 개수를 반환. */
  delete: (ids: number[]) => invoke<number>("schedule_delete", { ids }),
};

export const settingsApi = {
  /** 없으면 null. */
  get: (key: string) => invoke<string | null>("settings_get", { key }),
  set: (key: string, value: string) => invoke<void>("settings_set", { key, value }),
};

export const conversationApi = {
  load: (sessionId: string) =>
    invoke<ConversationMessage[]>("conversation_load", { sessionId }),
  save: (sessionId: string, role: string, content: string) =>
    invoke<void>("conversation_save", { sessionId, role, content }),
  delete: (sessionId: string) => invoke<void>("conversation_delete", { sessionId }),
};

export const execHistoryApi = {
  list: () => invoke<ExecHistoryItem[]>("exec_history_list"),
  save: (
    language: string,
    code: string,
    stdout: string,
    stderr: string,
    exitCode: number,
  ) => invoke<void>("exec_history_save", { language, code, stdout, stderr, exitCode }),
  clear: () => invoke<void>("exec_history_clear"),
};

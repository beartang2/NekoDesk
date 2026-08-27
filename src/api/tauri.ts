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
  FsDecision,
  FsEditResult,
  FsEntry,
  FsWriteResult,
  FsGrepHit,
  FsReadResult,
  Memory,
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

/**
 * 파일 접근. 경로 정책은 전부 Rust(`files::guard`)가 판정한다 — 프런트엔드는
 * 확인 창을 띄울지 결정하려고 `check` 를 먼저 물어볼 뿐이고, 실제 강제는 백엔드에
 * 있다. `approved` 는 "사용자에게 실제로 확인을 받았다" 는 뜻이다.
 */
export const fsApi = {
  read: (path: string, offset?: number, limit?: number) =>
    invoke<FsReadResult>("fs_read", { path, offset, limit }),
  write: (path: string, content: string, approved: boolean) =>
    invoke<FsWriteResult>("fs_write", { path, content, approved }),
  edit: (
    path: string,
    oldString: string,
    newString: string,
    replaceAll: boolean,
    approved: boolean
  ) =>
    invoke<FsEditResult>("fs_edit", { path, oldString, newString, replaceAll, approved }),
  list: (path: string) => invoke<FsEntry[]>("fs_list", { path }),
  glob: (pattern: string, base?: string) =>
    invoke<string[]>("fs_glob", { pattern, base }),
  grep: (pattern: string, base?: string, glob?: string, maxResults?: number) =>
    invoke<FsGrepHit[]>("fs_grep", { pattern, base, glob, maxResults }),
  /** 건드리기 전에 정책만 물어본다. */
  check: (path: string, write: boolean) =>
    invoke<FsDecision>("fs_check", { path, write }),
};

/**
 * stdio MCP 서버. HTTP(SSE) 서버는 프런트엔드가 직접 붙지만, stdio 는 로컬
 * 프로세스를 띄워야 해서 백엔드를 거친다.
 */
export const mcpApi = {
  start: (id: string, command: string, env?: Record<string, string>) =>
    invoke<{ server_name: string | null }>("mcp_stdio_start", { id, command, env }),
  rpc: (id: string, method: string, params: unknown) =>
    invoke<unknown>("mcp_stdio_rpc", { id, method, params }),
  stop: (id: string) => invoke<void>("mcp_stdio_stop", { id }),
  isRunning: (id: string) => invoke<boolean>("mcp_stdio_is_running", { id }),
};

/**
 * 세션을 넘어 남는 기억. 검색어 분해(한국어 조사 처리 포함)는 백엔드가 한다 —
 * 규칙을 양쪽이 나눠 가지면 어긋난다.
 */
export const memoryApi = {
  save: (content: string, kind?: string) =>
    invoke<Memory>("memory_save", { content, kind }),
  /** 자유 문장으로 검색. 떠올린 기억은 사용 횟수가 올라간다. */
  search: (query: string, limit?: number) =>
    invoke<Memory[]>("memory_search", { query, limit }),
  list: () => invoke<Memory[]>("memory_list"),
  delete: (id: number) => invoke<boolean>("memory_delete", { id }),
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

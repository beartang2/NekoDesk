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
  ProcessSnapshot,
  SecurityReport,
  Skill,
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

/** 열린 포트·무거운 프로세스. 읽기만 한다. */
export const processApi = {
  list: (port?: number) => invoke<ProcessSnapshot>("process_list", { port }),
};

/** 읽기 전용 보안 점검. 새 자동 실행 항목은 한 번 알리면 다음엔 안 실린다. */
export const securityApi = {
  /** `remember` 는 사용자가 직접 보는 브리핑만 켠다 — 새 자동 실행 항목을 "알렸다" 로 친다. */
  check: (remember = false) => invoke<SecurityReport>("security_check", { remember }),
};

/** 사용자가 `~/.nekodesk/skills/*.md` 에 넣어둔 지식. */
/** AirDrop 선택 시트를 연다. 받는 사람 선택은 사용자 몫이다. */
export const airdropApi = {
  send: (paths: string[]) => invoke<number>("airdrop_send", { paths }),
};

export const skillsApi = {
  load: () => invoke<Skill[]>("skills_load"),
};

/** 네코 산책 지도에 쓰는 실제 장소. */
export interface MapPlace {
  name: string;
  /** MKPointOfInterestCategory 원문(예: "MKPOICategoryPark"). */
  category: string;
  lat: number;
  lon: number;
}

/** 지도 한 장. 이미지 가운데가 요청한 (lat, lon), 북쪽이 위. */
export interface MapSnapshot {
  /** PNG data URL. */
  dataUrl: string;
  /** 요청한 width 기준 CSS 픽셀 1칸이 몇 미터인지. 위경도 → 픽셀 환산에 쓴다. */
  metersPerPx: number;
}

/** "역삼동 (37.5000,127.0364)" 꼴 문자열의 괄호 속 좌표. 없으면 null. */
export function coordsIn(text: string): { lat: number; lon: number } | null {
  const m = text.match(/\((-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)\)/);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}

/**
 * 네코 산책 지도. macOS MapKit(키·개발자 계정 불필요)을 Rust 에서 부른다 — 지도 그림·장소·경로
 * 요청은 Apple 서버로 간다.
 */
export const mapApi = {
  /** 날씨용 현재 위치 명령을 그대로 쓴다. 결과 문자열 "현재 위치 (37.5000,127.0364)" 의 괄호를 읽는다. */
  here: async (): Promise<{ lat: number; lon: number }> => {
    const text = await invoke<string>("location_current");
    const at = coordsIn(text);
    if (!at) throw new Error(`위치를 읽지 못했어: ${text}`);
    return at;
  },
  /** 날씨 칸의 위치(동네 이름이나 "현재 위치 (lat,lon)")가 가리키는 자리. 위치 권한이 없을 때 대신 쓴다. */
  weatherSpot: (location: string) =>
    invoke<{ lat: number; lon: number }>("weather_now", { location }).then(({ lat, lon }) => ({ lat, lon })),
  /** 가로 spanM 미터를 width×height CSS 픽셀에 담은 지도. dark 면 어두운 지도. */
  snapshot: (p: { lat: number; lon: number; spanM: number; width: number; height: number; dark: boolean }) =>
    invoke<MapSnapshot>("map_snapshot", p),
  /** 반경 radiusM 안의 공원·카페·도서관 같은 장소. */
  places: (p: { lat: number; lon: number; radiusM: number }) => invoke<MapPlace[]>("map_places", p),
  /** 두 점 사이 걷기 경로. [lat, lon] 점들(출발·도착 포함). 길을 못 찾으면 에러. */
  walkRoute: (p: { from: [number, number]; to: [number, number] }) =>
    invoke<[number, number][]>("map_walk_route", p),
};

export const settingsApi = {
  /** 없으면 null. API 키는 여기로 못 읽고 못 쓴다 — secretsApi. */
  get: (key: string) => invoke<string | null>("settings_get", { key }),
  set: (key: string, value: string) => invoke<void>("settings_set", { key, value }),
};

/** API 키(macOS 키체인). 화면엔 값을 돌려주지 않는다 — 저장했는지만 안다. */
export const secretsApi = {
  /** 빈 값이면 지운다. */
  set: (key: string, value: string) => invoke<void>("secret_set", { key, value }),
  has: (key: string) => invoke<boolean>("secret_has", { key }),
  /** dev 빌드의 복사 버튼용. 빌드한 앱에선 거절된다. */
  devGet: (key: string) => invoke<string | null>("secret_dev_get", { key }),
};

/** 예전 버전이 localStorage 에 적어 둔 Brave 키를 키체인으로 옮기고 지운다. */
export async function migrateLegacySecrets() {
  const LEGACY = "nekodesk_brave_search_key";
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(LEGACY);
  } catch {
    return;
  }
  if (legacy === null) return;
  if (legacy.trim() && !(await secretsApi.has("brave_search_key"))) {
    await secretsApi.set("brave_search_key", legacy);
  }
  localStorage.removeItem(LEGACY);
}

/** 임시 보관함에 둔 파일. path 는 끌어낼 때(startDrag) 쓴다. */
export interface ShelfItem {
  name: string;
  path: string;
  size: number;
}

export const shelfApi = {
  list: () => invoke<ShelfItem[]>("shelf_list"),
  /** 바이트는 JSON 이 아니라 그대로 보낸다. 헤더엔 ASCII 만 실려 이름은 인코딩한다. */
  add: async (file: File) =>
    invoke<ShelfItem>("shelf_add", new Uint8Array(await file.arrayBuffer()), {
      headers: { "x-name": encodeURIComponent(file.name) },
    }),
  remove: (name: string) => invoke<void>("shelf_remove", { name }),
};

export const conversationApi = {
  load: (sessionId: string) =>
    invoke<ConversationMessage[]>("conversation_load", { sessionId }),
  /**
   * `attachments` 는 AttachedFile 배열의 JSON. 껐다 켜도 미리보기가 남게 한다.
   * `meta` 는 답변의 도구 기록·계획 등(serializeMeta). 다시 열어도 패널이 남게 한다.
   */
  save: (sessionId: string, role: string, content: string, attachments?: string, meta?: string) =>
    invoke<void>("conversation_save", { sessionId, role, content, attachments, meta }),
  delete: (sessionId: string) => invoke<void>("conversation_delete", { sessionId }),
  /** 마지막으로 쓴 지 days 일 지난 세션의 대화를 지운다(keep 은 빼고). 지운 세션 id */
  prune: (days: number, keep: string[]) => invoke<string[]>("conversation_prune", { days, keep }),
};

/** 세션 목록(대화 탭)과 수동 요약. 예전엔 localStorage 에만 있어 다른 기기로 못 갔다(docs/neko-sync.md §2.6) */
export interface SessionRow { id: string; title: string; created_at: number; summary: string | null }
export const sessionApi = {
  list: () => invoke<SessionRow[]>("session_list"),
  /** 없으면 만들고 있으면 제목만 바꾼다 */
  put: (id: string, title: string, createdAt: number) => invoke<void>("session_put", { id, title, createdAt }),
  /** 처음 한 번 localStorage 목록을 옮긴다. 이미 있는 세션은 그대로 */
  import: (sessions: SessionRow[]) => invoke<void>("session_import", { sessions }),
  /** 사용자가 지운 세션(메시지까지) */
  delete: (id: string) => invoke<void>("session_delete", { id }),
  /** 수동 요약: 요약을 적고 그 세션 메시지를 지운다 */
  compact: (id: string, summary: string) => invoke<void>("session_compact", { id, summary }),
};

/**
 * 선물함은 선물 하나씩 바꾼다 — 백엔드가 DB 안에서 지금 배열에 합친다. 배열을 통째로 저장하면 동기화가 막 넣은
 * 선물을 화면이 못 본 채 덮어, 그 선물이 다른 기기에서도 지워졌다.
 */
export const giftsApi = {
  /** 새 선물(같은 id 면 바꾼다) */
  add: (gift: object) => invoke<void>("gift_add", { gift }),
  /** 있는 선물의 칸만 바꾼다. null 이면 그 칸을 뺀다. 없으면(다른 기기에서 지움) 아무것도 안 하고 false */
  patch: (id: string, patch: object) => invoke<boolean>("gift_patch", { id, patch }),
  remove: (ids: string[]) => invoke<void>("gift_remove", { ids }),
};

/** 기기 간 동기화(설정 › 동기화). 열쇠·토큰은 백엔드 키체인에만 있다 */
export interface SyncStatus {
  enabled: boolean;
  registered: boolean;
  url: string | null;
  device: string | null;
  last_sync: number | null;
  last_error: string | null;
}
/** 백엔드가 다 맞춘 뒤 보내는 이벤트. 바뀐 종류와 메시지가 바뀐 세션 */
export const SYNC_CHANGED = "sync-changed";
export interface SyncChanged { colls: string[]; sessions: string[]; first: boolean }
export const syncApi = {
  status: () => invoke<SyncStatus>("sync_status"),
  enable: (on: boolean) => invoke<void>("sync_enable", { on }),
  now: () => invoke<void>("sync_now"),
  /** 첫 기기: 배포 때 정한 SETUP_TOKEN 으로 등록 */
  setup: (url: string, setupToken: string) => invoke<void>("sync_setup", { url, setupToken }),
  /** 다른 기기에 붙여넣을 짝 문자열(10분) */
  /** `withClaude`: Claude API 키도 싣는다(받는 기기가 자기 키체인에 넣는다 — 폰에서 긴 키를 안 쳐도 되게). */
  pairMake: (withClaude = false) => invoke<string>("sync_pair_make", { withClaude }),
  pairJoin: (pairing: string) => invoke<void>("sync_pair_join", { pairing }),
  devices: () => invoke<{ devices: SyncDevice[]; me: string }>("sync_devices"),
  revoke: (id: string) => invoke<void>("sync_revoke", { id }),
  /** 다른 기기를 다 끊고 서버를 비운 뒤 새 열쇠로 이 맥 것을 다시 올린다 */
  rekey: () => invoke<void>("sync_rekey"),
};
export interface SyncDevice { id: string; name: string; created_at: number; last_seen: number | null; revoked: number }

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

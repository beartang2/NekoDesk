import { invoke } from "@tauri-apps/api/core";
import { todosApi, scheduleApi, execHistoryApi, type ScheduleRange } from "../api/tauri";
import { appEvents, requestWordchainFirstWord } from "../lib/events";
import { getFile, getStoredFileNames } from "./file-store";
import type {
  ToolName,
  JsonSchema,
  Todo,
  ScheduleEvent,
  SearchResult,
  ScrapResult,
  CodeExecResult,
} from "./types";

// ── Result summarizers ────────────────────────────────────────────────────────

function summarizeTodos(todos: Todo[]): string {
  if (todos.length === 0) return "할 일 없음";
  return todos
    .map((t) => `- [${t.status}] ${t.content}${t.due_at ? ` (마감: ${t.due_at})` : ""}`)
    .join("\n");
}

function summarizeEvents(events: ScheduleEvent[]): string {
  if (events.length === 0) return "일정 없음";
  return events.map((e) => `- [id:${e.id}] ${e.title} (${e.start_at})`).join("\n");
}

function summarizeSearch(results: SearchResult[]): string {
  if (results.length === 0) return "검색 결과 없음";
  return results.map((r) => `- ${r.title}: ${r.snippet}`).join("\n");
}

// ── Tool registry ─────────────────────────────────────────────────────────────

export interface ToolEntry {
  name: ToolName;
  description: string;
  /**
   * JSON Schema. native tool calling 의 `tools` 배열과 json 폴백 모드의 프롬프트
   * 텍스트가 **둘 다 여기서** 생성된다(tool-schemas.ts). 손으로 쓴 프롬프트 설명과
   * 어긋날 여지를 없앤다.
   */
  params: JsonSchema;
  /**
   * 부작용이 없어 같은 턴의 다른 호출과 동시에 실행해도 되는가.
   * false 면 순차 실행한다(쓰기·확인 필요·순서 의존).
   */
  readOnly: boolean;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
  resultLimit: number;
  summarize: (result: unknown) => string;
}

/** 파라미터 없는 툴의 스키마. */
const NO_PARAMS: JsonSchema = { type: "object", properties: {} };

/** 루프가 execute 전에 가로채는 가상 툴. 실수로 불리면 즉시 드러나게 던진다. */
function virtual(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`${name} 은 에이전트 루프가 직접 처리해야 하는 가상 툴이야`);
  };
}

const REGISTRY: Record<ToolName, ToolEntry> = {
  "todo.list": {
    name: "todo.list",
    description: "열린 할 일 목록을 가져온다",
    params: NO_PARAMS,
    readOnly: true,
    execute: async () => todosApi.list(),
    resultLimit: 5,
    summarize: (r) => summarizeTodos((r as Todo[]).slice(0, 5)),
  },

  "todo.list_done": {
    name: "todo.list_done",
    description: "완료된 할 일 목록을 가져온다 (최근 완료순)",
    params: NO_PARAMS,
    readOnly: true,
    execute: async () => todosApi.listDone(),
    resultLimit: 10,
    summarize: (r) => summarizeTodos((r as Todo[]).slice(0, 10)),
  },

  "todo.add": {
    name: "todo.add",
    description: "할 일을 추가한다",
    params: {
      type: "object",
      properties: {
        content: { type: "string", description: "할 일 내용" },
        due_at: { type: "string", description: "마감 시각 (ISO 8601). 없으면 생략" },
      },
      required: ["content"],
    },
    readOnly: false,
    execute: async (p) =>
      todosApi.add(
        p["content"] as string,
        (p["due_at"] as string | null | undefined) ?? null
      ),
    resultLimit: 1,
    summarize: (r) => `할 일 추가됨: ${(r as Todo).id}`,
  },

  "todo.complete": {
    name: "todo.complete",
    description: "할 일을 완료 처리한다",
    params: {
      type: "object",
      properties: { id: { type: "number", description: "todo.list 로 확인한 할 일 id" } },
      required: ["id"],
    },
    readOnly: false,
    execute: async (p) => todosApi.complete(p["id"] as number),
    resultLimit: 1,
    summarize: () => "완료 처리됨",
  },

  "schedule.list": {
    name: "schedule.list",
    description: "일정을 조회한다",
    params: {
      type: "object",
      properties: {
        range: { type: "string", enum: ["today", "week", "all"], description: "조회 범위" },
      },
      required: ["range"],
    },
    readOnly: true,
    execute: async (p) =>
      scheduleApi.list((p["range"] as ScheduleRange) ?? "all"),
    resultLimit: 5,
    summarize: (r) => summarizeEvents((r as ScheduleEvent[]).slice(0, 5)),
  },

  "schedule.add": {
    name: "schedule.add",
    description: "일정을 추가한다 (하루 단위, 여러 날짜는 각각 호출)",
    params: {
      type: "object",
      properties: {
        title: { type: "string", description: "일정 제목" },
        start_at: {
          type: "string",
          description: 'ISO 8601 (예: "2026-05-22" 또는 "2026-05-22T14:00:00")',
        },
      },
      required: ["title", "start_at"],
    },
    readOnly: false,
    execute: async (p) =>
      scheduleApi.add(p["title"] as string, p["start_at"] as string),
    resultLimit: 1,
    summarize: (r) => `일정 추가됨: ${(r as ScheduleEvent).title}`,
  },

  "schedule.delete": {
    name: "schedule.delete",
    description: "일정을 삭제한다. ids 배열로 여러 개 동시 삭제 가능. 반드시 schedule.list로 실제 id를 확인한 후 사용할 것",
    params: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "number" }, description: "삭제할 일정 id 배열" },
      },
      required: ["ids"],
    },
    readOnly: false,
    execute: async (p) => scheduleApi.delete(p["ids"] as number[]),
    resultLimit: 1,
    summarize: (r) => {
      const n = r as number;
      if (n === 0) return "일정 삭제 실패: 해당 ID의 일정이 존재하지 않음";
      return `일정 ${n}개 삭제됨`;
    },
  },

  "code.exec": {
    name: "code.exec",
    description:
      "Python, Shell, AppleScript 를 로컬에서 실행하고 결과를 반환한다. " +
      'language 가 "applescript" 일 때 code 는 순수 AppleScript 문법만 쓴다 ' +
      '(osascript -e 래퍼 금지. 예: tell application "Music" to get name of current track)',
    params: {
      type: "object",
      properties: {
        code: { type: "string", description: "실행할 코드" },
        language: {
          type: "string",
          enum: ["python", "shell", "applescript"],
          description: "코드 언어",
        },
        work_dir: { type: "string", description: "작업 디렉토리. 없으면 홈" },
      },
      required: ["code", "language"],
    },
    readOnly: false,
    execute: async (p) => {
      const result = await invoke<CodeExecResult>("code_exec", {
        code: p["code"] as string,
        language: (p["language"] as string | undefined) ?? "python",
        workDir: (p["work_dir"] as string | null | undefined) ?? null,
      });
      appEvents.emit("coderun", result);
      execHistoryApi.save(
        (p["language"] as string | undefined) ?? "python",
        p["code"] as string,
        result.stdout,
        result.stderr,
        result.exit_code,
      ).catch(() => {});
      return result;
    },
    resultLimit: 1,
    summarize: (r) => {
      const res = r as CodeExecResult;
      const lines: string[] = [];
      if (res.stdout) lines.push(`stdout:\n${res.stdout}`);
      if (res.stderr) lines.push(`stderr:\n${res.stderr}`);
      lines.push(`exit_code: ${res.exit_code}`);
      if (res.truncated) lines.push("(출력 일부 잘림)");
      return lines.join("\n");
    },
  },

  "web.search": {
    name: "web.search",
    description: "웹에서 정보를 검색한다",
    params: {
      type: "object",
      properties: { query: { type: "string", description: "검색어. 영어 우선" } },
      required: ["query"],
    },
    readOnly: true,
    execute: async (p) => invoke<SearchResult[]>("web_search", { query: p["query"] as string }),
    resultLimit: 3,
    summarize: (r) => summarizeSearch((r as SearchResult[]).slice(0, 3)),
  },

  "web.scrape": {
    name: "web.scrape",
    description: "특정 URL의 페이지 내용을 가져온다. web.search 결과에 나온 URL만 사용할 것",
    params: {
      type: "object",
      properties: { url: { type: "string", description: "web.search 결과에서 그대로 복사한 URL" } },
      required: ["url"],
    },
    readOnly: true,
    execute: async (p) => invoke<ScrapResult>("web_scrape", { url: p["url"] as string }),
    resultLimit: 1,
    summarize: (r) => {
      const res = r as ScrapResult;
      return `[${res.title}]\n${res.content.slice(0, 500)}`;
    },
  },

  "weather.get": {
    name: "weather.get",
    description: "현재 날씨와 단기 예보를 가져온다",
    params: {
      type: "object",
      properties: { location: { type: "string", description: "지역명" } },
      required: ["location"],
    },
    readOnly: true,
    execute: async (p) => invoke<string>("weather_get", { location: p["location"] as string }),
    resultLimit: 1,
    summarize: (r) => r as string,
  },

  "game.start": {
    name: "game.start",
    description: "미니게임을 시작한다. 'drawing' = 그림 맞추기(고양이가 그림 보고 추리), 'wordchain' = 끝말잇기(한국어 단어 이어받기)",
    params: {
      type: "object",
      properties: { type: { type: "string", enum: ["drawing", "wordchain"] } },
      required: ["type"],
    },
    readOnly: false,
    execute: async (p) => {
      const type = (p["type"] as string) === "wordchain" ? "wordchain" : "drawing";
      if (type === "wordchain") {
        const firstWord = await requestWordchainFirstWord();
        return { started: "wordchain", firstWord };
      }
      appEvents.emit("startGame", { type: "drawing" });
      return { started: type };
    },
    resultLimit: 1,
    summarize: (r) => {
      const res = r as { started: string; firstWord?: string | null };
      if (res.started === "wordchain") {
        if (res.firstWord) {
          const last = res.firstWord[res.firstWord.length - 1];
          return `끝말잇기 게임 시작. 고양이 첫 단어: "${res.firstWord}". 유저는 "${last}"로 시작하는 단어를 말해야 함.`;
        }
        return "끝말잇기 게임 시작 실패";
      }
      return "그림 맞추기 게임 시작!";
    },
  },

  "file.upload": {
    name: "file.upload",
    description:
      "첨부된 파일을 HTTP 엔드포인트에 multipart/form-data로 업로드한다. " +
      "url 은 사용자가 직접 알려준 실제 URL만 쓴다. 추측하거나 만들어내지 않는다",
    params: {
      type: "object",
      properties: {
        url: { type: "string", description: "사용자가 알려준 업로드 URL" },
        field_name: { type: "string", description: 'form field 이름. 기본 "file"' },
        filename: { type: "string", description: "첨부된 파일 이름" },
      },
      required: ["url", "filename"],
    },
    readOnly: false,
    execute: async (p) => {
      const url = p["url"] as string;
      const fieldName = (p["field_name"] as string | undefined) ?? "file";
      const filename = p["filename"] as string;

      const file = getFile(filename);
      if (!file) {
        const available = getStoredFileNames();
        throw new Error(
          `첨부 파일을 찾을 수 없습니다: "${filename}". 사용 가능한 파일: ${available.length > 0 ? available.join(", ") : "없음"}`
        );
      }

      const formData = new FormData();
      formData.append(fieldName, file, filename);

      const res = await fetch(url, { method: "POST", body: formData });
      if (!res.ok) {
        throw new Error(`업로드 실패 (HTTP ${res.status}): ${await res.text()}`);
      }
      return (await res.json()) as unknown;
    },
    resultLimit: 1,
    summarize: (r) => JSON.stringify(r).slice(0, 300),
  },

  // 가상 툴 — 루프가 execute 전에 가로채 UI 로 질문을 띄운다. 스키마가 여기 있어야
  // native tool calling 의 tools 배열에 실린다.
  "user.ask": {
    name: "user.ask",
    description:
      "작업 전에 사용자에게 선택지로 질문한다. 되돌리기 어려운 작업 직전이거나, " +
      "추천·창작처럼 취향·조건이 불명확해 방향이 여러 갈래일 때만 쓴다. 명확한 요청엔 쓰지 않는다",
    params: {
      type: "object",
      properties: {
        question: { type: "string", description: "사용자에게 보여줄 질문" },
        options: { type: "array", items: { type: "string" }, description: "선택지 2~4개" },
      },
      required: ["question", "options"],
    },
    readOnly: false,
    execute: virtual("user.ask"),
    resultLimit: 1,
    summarize: (r) => `사용자 답변: ${String(r)}`,
  },
};

export function getTool(name: ToolName): ToolEntry {
  return REGISTRY[name];
}

export function getAllTools(): ToolEntry[] {
  return Object.values(REGISTRY);
}

export function isStaticTool(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name);
}

/**
 * 같은 턴의 다른 호출과 동시에 실행해도 되는가.
 * 모르는 툴(MCP 등)은 false — 부작용 여부를 알 수 없으니 순차 실행한다.
 */
export function isParallelSafe(name: string): boolean {
  return isStaticTool(name) ? REGISTRY[name].readOnly : false;
}

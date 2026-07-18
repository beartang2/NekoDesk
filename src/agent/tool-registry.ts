import { invoke } from "@tauri-apps/api/core";
import { todosApi, scheduleApi, execHistoryApi, type ScheduleRange } from "../api/tauri";
import { appEvents, requestWordchainFirstWord } from "../lib/events";
import { getFile, getStoredFileNames } from "./file-store";
import type {
  ToolName,
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
  execute: (params: Record<string, unknown>) => Promise<unknown>;
  resultLimit: number;
  summarize: (result: unknown) => string;
}

const REGISTRY: Record<ToolName, ToolEntry> = {
  "todo.list": {
    name: "todo.list",
    description: "열린 할 일 목록을 가져온다",
    execute: async () => todosApi.list(),
    resultLimit: 5,
    summarize: (r) => summarizeTodos((r as Todo[]).slice(0, 5)),
  },

  "todo.list_done": {
    name: "todo.list_done",
    description: "완료된 할 일 목록을 가져온다 (최근 완료순)",
    execute: async () => todosApi.listDone(),
    resultLimit: 10,
    summarize: (r) => summarizeTodos((r as Todo[]).slice(0, 10)),
  },

  "todo.add": {
    name: "todo.add",
    description: "할 일을 추가한다",
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
    execute: async (p) => todosApi.complete(p["id"] as number),
    resultLimit: 1,
    summarize: () => "완료 처리됨",
  },

  "schedule.list": {
    name: "schedule.list",
    description: "일정을 조회한다",
    execute: async (p) =>
      scheduleApi.list((p["range"] as ScheduleRange) ?? "all"),
    resultLimit: 5,
    summarize: (r) => summarizeEvents((r as ScheduleEvent[]).slice(0, 5)),
  },

  "schedule.add": {
    name: "schedule.add",
    description: "일정을 추가한다 (하루 단위, 여러 날짜는 각각 호출)",
    execute: async (p) =>
      scheduleApi.add(p["title"] as string, p["start_at"] as string),
    resultLimit: 1,
    summarize: (r) => `일정 추가됨: ${(r as ScheduleEvent).title}`,
  },

  "schedule.delete": {
    name: "schedule.delete",
    description: "일정을 삭제한다. ids 배열로 여러 개 동시 삭제 가능. 반드시 schedule.list로 실제 id를 확인한 후 사용할 것",
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
    description: "Python 또는 Shell 스크립트를 로컬에서 실행하고 결과를 반환한다",
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
    execute: async (p) => invoke<SearchResult[]>("web_search", { query: p["query"] as string }),
    resultLimit: 3,
    summarize: (r) => summarizeSearch((r as SearchResult[]).slice(0, 3)),
  },

  "web.scrape": {
    name: "web.scrape",
    description: "특정 URL의 페이지 내용을 가져온다",
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
    execute: async (p) => invoke<string>("weather_get", { location: p["location"] as string }),
    resultLimit: 1,
    summarize: (r) => r as string,
  },

  "game.start": {
    name: "game.start",
    description: "미니게임을 시작한다. type: 'drawing' = 그림 맞추기(고양이가 그림 보고 추리), 'wordchain' = 끝말잇기(한국어 단어 이어받기)",
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
    description: "첨부된 파일을 HTTP 엔드포인트에 multipart/form-data로 업로드한다",
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
};

export function getTool(name: ToolName): ToolEntry {
  return REGISTRY[name];
}

export function getAllTools(): ToolEntry[] {
  return Object.values(REGISTRY);
}

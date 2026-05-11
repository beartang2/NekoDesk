import { invoke } from "@tauri-apps/api/core";
import { getFile, getStoredFileNames } from "./file-store";
import type {
  ToolName,
  Todo,
  ScheduleEvent,
  SearchResult,
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
  return events.map((e) => `- ${e.title} (${e.start_at})`).join("\n");
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
    execute: async () => invoke<Todo[]>("todo_list"),
    resultLimit: 5,
    summarize: (r) => summarizeTodos((r as Todo[]).slice(0, 5)),
  },

  "todo.add": {
    name: "todo.add",
    description: "할 일을 추가한다",
    execute: async (p) =>
      invoke<Todo>("todo_add", {
        content: p["content"] as string,
        dueAt: (p["due_at"] as string | null | undefined) ?? null,
      }),
    resultLimit: 1,
    summarize: (r) => `할 일 추가됨: ${(r as Todo).id}`,
  },

  "todo.complete": {
    name: "todo.complete",
    description: "할 일을 완료 처리한다",
    execute: async (p) => invoke<boolean>("todo_complete", { id: p["id"] as number }),
    resultLimit: 1,
    summarize: () => "완료 처리됨",
  },

  "schedule.list": {
    name: "schedule.list",
    description: "일정을 조회한다",
    execute: async (p) =>
      invoke<ScheduleEvent[]>("schedule_list", {
        range: (p["range"] as string | undefined) ?? "all",
      }),
    resultLimit: 5,
    summarize: (r) => summarizeEvents((r as ScheduleEvent[]).slice(0, 5)),
  },

  "schedule.add": {
    name: "schedule.add",
    description: "일정을 추가한다",
    execute: async (p) =>
      invoke<ScheduleEvent>("schedule_add", {
        title: p["title"] as string,
        startAt: p["start_at"] as string,
        endAt: (p["end_at"] as string | null | undefined) ?? null,
      }),
    resultLimit: 1,
    summarize: (r) => `일정 추가됨: ${(r as ScheduleEvent).title}`,
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
      window.dispatchEvent(new CustomEvent("nekodesk:coderun", { detail: result }));
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

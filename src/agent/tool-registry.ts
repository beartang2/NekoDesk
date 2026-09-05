import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";
import { readTextFile, writeTextFile, readDir, mkdir, exists } from "@tauri-apps/plugin-fs";
import { readText as clipboardReadText, writeText as clipboardWriteText } from "@tauri-apps/plugin-clipboard-manager";
import { evaluate as mathEvaluate } from "mathjs";
import { todosApi, scheduleApi, execHistoryApi, type ScheduleRange } from "../api/tauri";
import { appEvents, requestWordchainFirstWord } from "../lib/events";
import { getFile, getStoredFileNames } from "./file-store";
import { normalizeDateInput } from "./korean-date";
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

function summarizeDirEntries(entries: { name: string; isDirectory: boolean }[]): string {
  if (entries.length === 0) return "빈 폴더";
  return entries
    .slice(0, 60)
    .map((e) => (e.isDirectory ? `${e.name}/` : e.name))
    .join("\n");
}

// ── Tool registry ─────────────────────────────────────────────────────────────

export interface ToolEntry {
  name: ToolName;
  description: string;
  /**
   * 파라미터 스키마. GBNF 는 JSON 의 "형태"만 강제할 뿐 "의미"는 못 잡는다
   * (필수 필드 누락, 타입 불일치, 잘못된 enum 값). 실행 전에 여기서 걸러
   * 모델에게 교정 메시지를 돌려준다.
   */
  schema: z.ZodType;
  execute: (params: Record<string, unknown>) => Promise<unknown>;
  resultLimit: number;
  summarize: (result: unknown) => string;
}

const REGISTRY: Record<ToolName, ToolEntry> = {
  "todo.list": {
    name: "todo.list",
    description: "열린 할 일 목록을 가져온다",
    schema: z.object({}).loose(),
    execute: async () => todosApi.list(),
    resultLimit: 5,
    summarize: (r) => summarizeTodos((r as Todo[]).slice(0, 5)),
  },

  "todo.list_done": {
    name: "todo.list_done",
    description: "완료된 할 일 목록을 가져온다 (최근 완료순)",
    schema: z.object({}).loose(),
    execute: async () => todosApi.listDone(),
    resultLimit: 10,
    summarize: (r) => summarizeTodos((r as Todo[]).slice(0, 10)),
  },

  "todo.add": {
    name: "todo.add",
    description: "할 일을 추가한다",
    schema: z.object({
      content: z.string().min(1, "할 일 내용은 비울 수 없다"),
      due_at: z.string().nullish(),
    }),
    execute: async (p) => {
      const due = p["due_at"] as string | null | undefined;
      return todosApi.add(
        p["content"] as string,
        due ? normalizeDateInput(due) : null
      );
    },
    resultLimit: 1,
    summarize: (r) => `할 일 추가됨: ${(r as Todo).id}`,
  },

  "todo.complete": {
    name: "todo.complete",
    description: "할 일을 완료 처리한다",
    schema: z.object({
      id: z.coerce.number().int("id 는 정수여야 한다"),
    }),
    execute: async (p) => todosApi.complete(p["id"] as number),
    resultLimit: 1,
    summarize: () => "완료 처리됨",
  },

  "schedule.list": {
    name: "schedule.list",
    description: "일정을 조회한다",
    schema: z.object({
      range: z.enum(["today", "week", "all"]).nullish(),
    }),
    execute: async (p) =>
      scheduleApi.list((p["range"] as ScheduleRange) ?? "all"),
    resultLimit: 5,
    summarize: (r) => summarizeEvents((r as ScheduleEvent[]).slice(0, 5)),
  },

  "schedule.add": {
    name: "schedule.add",
    description: "일정을 추가한다 (하루 단위, 여러 날짜는 각각 호출)",
    schema: z.object({
      title: z.string().min(1, "일정 제목은 비울 수 없다"),
      start_at: z.string().min(1, "start_at 이 필요하다"),
    }),
    // start_at 은 모델이 ISO 로 바꿔서 주게 되어 있지만, 4B급 모델은 "다음 주
    // 화요일" 같은 상대 표현을 그대로 흘리거나 날짜 산수를 틀린다.
    // 한국어 표현이 들어오면 여기서 결정론적으로 교정한다.
    execute: async (p) =>
      scheduleApi.add(
        p["title"] as string,
        normalizeDateInput(p["start_at"] as string)
      ),
    resultLimit: 1,
    summarize: (r) => `일정 추가됨: ${(r as ScheduleEvent).title}`,
  },

  "schedule.delete": {
    name: "schedule.delete",
    description: "일정을 삭제한다. ids 배열로 여러 개 동시 삭제 가능. 반드시 schedule.list로 실제 id를 확인한 후 사용할 것",
    schema: z.object({
      ids: z.array(z.coerce.number().int()).min(1, "삭제할 일정 id 가 최소 하나 필요하다"),
    }),
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
    schema: z.object({
      code: z.string().min(1, "실행할 코드가 필요하다"),
      language: z.enum(["python", "shell", "applescript", "osascript"]).nullish(),
      work_dir: z.string().nullish(),
    }),
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
    schema: z.object({
      query: z.string().min(1, "검색어가 필요하다"),
    }),
    execute: async (p) => invoke<SearchResult[]>("web_search", { query: p["query"] as string }),
    resultLimit: 3,
    summarize: (r) => summarizeSearch((r as SearchResult[]).slice(0, 3)),
  },

  "web.scrape": {
    name: "web.scrape",
    description: "특정 URL의 페이지 내용을 가져온다",
    schema: z.object({
      url: z.url("http(s) 로 시작하는 실제 URL 이어야 한다"),
    }),
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
    schema: z.object({
      location: z.string().min(1, "지역명이 필요하다"),
    }),
    execute: async (p) => invoke<string>("weather_get", { location: p["location"] as string }),
    resultLimit: 1,
    summarize: (r) => r as string,
  },

  "game.start": {
    name: "game.start",
    description: "미니게임을 시작한다. type: 'drawing' = 그림 맞추기(고양이가 그림 보고 추리), 'wordchain' = 끝말잇기(한국어 단어 이어받기)",
    schema: z.object({
      type: z.enum(["drawing", "wordchain"]).nullish(),
    }),
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
    schema: z.object({
      url: z.url("실제 업로드 URL 이 필요하다"),
      field_name: z.string().nullish(),
      filename: z.string().min(1, "업로드할 첨부 파일명이 필요하다"),
    }),
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

  // 읽기/쓰기/목록을 도구 3개로 쪼개지 않고 action 으로 묶었다. 4B급 모델은
  // 도구 개수가 늘수록 엉뚱한 선택을 하므로, 같은 도메인은 한 도구로 유지한다.
  // 대신 action 별 필수 필드는 아래 스키마가 강제한다.
  file: {
    name: "file",
    description: "로컬 파일을 읽거나 쓰거나 폴더 목록을 본다",
    schema: z
      .object({
        action: z.enum(["read", "write", "list"]),
        path: z.string().min(1, "path 가 필요하다"),
        content: z.string().nullish(),
        append: z.boolean().nullish(),
      })
      .refine((v) => v.action !== "write" || typeof v.content === "string", {
        message: "action 이 write 면 content 가 반드시 있어야 한다",
        path: ["content"],
      }),
    execute: async (p) => {
      const action = p["action"] as "read" | "write" | "list";
      const path = p["path"] as string;

      if (action === "read") {
        if (!(await exists(path))) throw new Error(`파일이 없어: ${path}`);
        const text = await readTextFile(path);
        return { path, content: text };
      }

      if (action === "list") {
        const entries = await readDir(path);
        return {
          path,
          entries: entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory })),
        };
      }

      // write: 상위 폴더가 없으면 만들어 준다. 모델이 mkdir 을 따로 부르지
      // 않아도 되게 해서 실패 왕복을 줄인다.
      const content = p["content"] as string;
      const dir = path.slice(0, path.lastIndexOf("/"));
      if (dir && !(await exists(dir))) {
        await mkdir(dir, { recursive: true });
      }
      if (p["append"] === true && (await exists(path))) {
        const prev = await readTextFile(path);
        await writeTextFile(path, prev + content);
      } else {
        await writeTextFile(path, content);
      }
      return { path, written: content.length };
    },
    resultLimit: 1,
    summarize: (r) => {
      const res = r as {
        path: string;
        content?: string;
        entries?: { name: string; isDirectory: boolean }[];
        written?: number;
      };
      if (res.entries) return `${res.path}\n${summarizeDirEntries(res.entries)}`;
      if (typeof res.written === "number") return `저장됨: ${res.path} (${res.written}자)`;
      const body = res.content ?? "";
      const clipped = body.slice(0, 4000);
      return clipped + (body.length > clipped.length ? "\n…(생략됨)" : "");
    },
  },

  clipboard: {
    name: "clipboard",
    description: "클립보드를 읽거나 쓴다",
    schema: z
      .object({
        action: z.enum(["read", "write"]),
        text: z.string().nullish(),
      })
      .refine((v) => v.action !== "write" || typeof v.text === "string", {
        message: "action 이 write 면 text 가 반드시 있어야 한다",
        path: ["text"],
      }),
    execute: async (p) => {
      if (p["action"] === "read") {
        const text = await clipboardReadText();
        return { text: text ?? "" };
      }
      await clipboardWriteText(p["text"] as string);
      return { written: true };
    },
    resultLimit: 1,
    summarize: (r) => {
      const res = r as { text?: string; written?: boolean };
      if (res.written) return "클립보드에 복사됨";
      const t = res.text ?? "";
      return t ? t.slice(0, 2000) : "클립보드가 비어 있음";
    },
  },

  // 작은 모델은 곱셈·단위 변환·퍼센트에서 자주 틀린다. code.exec 로 파이썬을
  // 띄우는 건 무거우니 즉시 계산으로 끝낸다.
  "math.eval": {
    name: "math.eval",
    description: "수식을 계산한다. 단위 변환도 가능 (예: '3 kg to lb')",
    schema: z.object({
      expression: z
        .string()
        .min(1, "계산할 수식이 필요하다")
        .max(500, "수식이 너무 길다. code.exec 를 써라"),
    }),
    execute: async (p) => {
      const expression = p["expression"] as string;
      const value = mathEvaluate(expression);
      return { expression, result: String(value) };
    },
    resultLimit: 1,
    summarize: (r) => {
      const res = r as { expression: string; result: string };
      return `${res.expression} = ${res.result}`;
    },
  },
};

/** 파라미터 검증 실패. 모델에게 교정 메시지를 돌려주기 위해 별도 타입으로 구분한다. */
export class ToolParamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolParamError";
  }
}

/**
 * 실행 전에 파라미터를 검증한다.
 *
 * 실패하면 어떤 필드가 왜 잘못됐는지를 담은 ToolParamError 를 던진다.
 * 이 메시지는 그대로 다음 턴의 컨텍스트로 들어가서 모델이 스스로 고치게 만든다.
 */
export function validateToolParams(
  entry: ToolEntry,
  params: Record<string, unknown>
): Record<string, unknown> {
  const parsed = entry.schema.safeParse(params ?? {});
  if (parsed.success) return parsed.data as Record<string, unknown>;

  const detail = parsed.error.issues
    .map((issue) => {
      const field = issue.path.join(".");
      return field ? `${field}: ${issue.message}` : issue.message;
    })
    .join(", ");
  throw new ToolParamError(`${entry.name} 파라미터가 올바르지 않아 — ${detail}`);
}

export function getTool(name: ToolName): ToolEntry {
  return REGISTRY[name];
}

export function getAllTools(): ToolEntry[] {
  return Object.values(REGISTRY);
}

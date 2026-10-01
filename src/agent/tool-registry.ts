import { invoke } from "@tauri-apps/api/core";
import {
  airdropApi,
  todosApi,
  scheduleApi,
  execHistoryApi,
  fsApi,
  memoryApi,
  type ScheduleRange,
} from "../api/tauri";
import { appEvents, requestWordchainFirstWord } from "../lib/events";
import { getFile, getStoredFileNames } from "./file-store";
import { buildSkillIndex, readKnowledge } from "./knowledge";
import type {
  ToolName,
  JsonSchema,
  FsEditResult,
  FsEntry,
  FsWriteResult,
  FsGrepHit,
  FsReadResult,
  Memory,
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
  // URL 을 빼면 모델이 web.scrape 할 주소를 지어낸다(404 → 재검색 루프).
  return results.map((r) => `- ${r.title} (${r.url}): ${r.snippet}`).join("\n");
}

function summarizeGrep(hits: FsGrepHit[]): string {
  if (hits.length === 0) return "일치하는 줄 없음";
  return hits.map((h) => `${h.path}:${h.line_no}: ${h.text.trim()}`).join("\n");
}

function summarizeEntries(entries: FsEntry[]): string {
  if (entries.length === 0) return "빈 디렉토리";
  return entries.map((e) => (e.is_dir ? `${e.name}/` : `${e.name} (${e.size}B)`)).join("\n");
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

  "skill.read": {
    name: "skill.read",
    description:
      "참고 지식 문서를 읽는다. 시스템 프롬프트의 '참고 지식 목록' 에 있는 이름을 그대로 넣어라. " +
      "목록에 해당하는 작업(그림 그리기, AppleScript 로 macOS 조작 등)이면 코드를 쓰기 전에 먼저 읽어라. " +
      "문서에 그 작업의 규칙과 예시가 들어 있어서, 안 읽고 시작하면 결과가 나빠진다.",
    params: {
      type: "object",
      properties: {
        name: { type: "string", description: '지식 이름. 예: "그림그리기"' },
      },
      required: ["name"],
    },
    readOnly: true,
    execute: async (p) => {
      const found = readKnowledge(p["name"] as string);
      // 이름을 틀렸을 때 목록을 같이 돌려준다. 모델이 한 번 더 추측하지 않고 고른다.
      return found ?? { error: `"${p["name"]}" 라는 지식은 없어. 있는 것:\n${buildSkillIndex()}` };
    },
    resultLimit: 1,
    summarize: (r) => {
      const v = r as { name?: string; content?: string; error?: string };
      return v.error ?? `### ${v.name}\n${v.content}`;
    },
  },

  "code.exec": {
    name: "code.exec",
    description:
      "Python, Shell, AppleScript 를 로컬에서 실행하고 결과를 반환한다. " +
      'language 가 "applescript" 일 때 code 는 순수 AppleScript 문법만 쓴다 ' +
      '(osascript -e 래퍼 금지. 예: tell application "Music" to get name of current track). ' +
      "파일·이미지는 상대 경로로 저장해라. work_dir 을 안 주면 네코 출력 폴더(~/.nekodesk/output)에서 실행되니 거기 모인다. " +
      "이미지는 저장만 하면 파일명과 무관하게 채팅에 표시된다 (plt.show() 금지). " +
      "그림을 새로 그릴 때는 PIL 도형 조합 대신 .svg 파일로 저장해라 — 그대로 렌더된다.",
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
        // 루프가 승인 게이트를 통과시킨 뒤에만 채운다(agent-loop 의 runCall).
        // registry 를 직접 부르는 경로는 승인을 못 받았다는 뜻이라 백엔드가 거부한다.
        approved: p["__approved"] === true,
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

  "game.judge": {
    name: "game.judge",
    description:
      "끝말잇기 이의 제기에 판정을 내린다. 사용자가 고양이 단어에 이의를 걸면, web.search 로 그 단어가 " +
      "국어사전에 실린 말인지 확인한 뒤 반드시 이걸 불러 결과를 정해라. 게임을 끝낼지는 이 판정이 정한다 — " +
      "말로만 '내가 졌어' 라고 하면 게임은 안 끝난다.",
    params: {
      type: "object",
      properties: {
        exists: { type: "boolean", description: "사전에 실린 단어면 true(게임 계속), 없는 말이면 false(고양이 패배)" },
      },
      required: ["exists"],
    },
    readOnly: false,
    execute: async (p) => {
      const exists = p["exists"] === true;
      appEvents.emit("wordchainVerdict", { exists });
      return { exists };
    },
    resultLimit: 1,
    // 모델이 판정 뒤에 할 말이 앱 상태와 어긋나지 않게, 무엇이 반영됐는지 그대로 알려준다.
    summarize: (r) =>
      (r as { exists: boolean }).exists
        ? "판정 반영됨: 있는 단어. 게임은 계속되고, 사용자가 이어서 단어를 낼 차례다."
        : "판정 반영됨: 없는 단어. 고양이 패배로 게임이 끝났다.",
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


  // ── 파일 ──────────────────────────────────────────────────────────────────
  // 쓰기 계열(fs.write / fs.edit)은 루프가 먼저 확인을 받은 뒤 approved 를 넘긴다.
  // 여기서 approved:false 로 부르면 백엔드가 거부한다 — 확인을 우회할 수 없다.

  "fs.read": {
    name: "fs.read",
    description:
      "파일을 읽는다. 줄번호가 붙어서 오니 fs.edit 대상을 고를 때 참고해. " +
      "긴 파일은 offset/limit 으로 이어 읽어",
    params: {
      type: "object",
      properties: {
        path: { type: "string", description: "파일 경로. ~ 로 홈을 쓸 수 있다" },
        offset: { type: "number", description: "건너뛸 줄 수" },
        limit: { type: "number", description: "읽을 줄 수. 기본 2000" },
      },
      required: ["path"],
    },
    readOnly: true,
    execute: async (p) =>
      fsApi.read(
        p["path"] as string,
        p["offset"] as number | undefined,
        p["limit"] as number | undefined
      ),
    resultLimit: 1,
    summarize: (r) => {
      const res = r as FsReadResult;
      return res.truncated
        ? `${res.content}\n\n(전체 ${res.total_lines}줄 중 일부. offset 을 올려 이어 읽어)`
        : res.content;
    },
  },

  "fs.write": {
    name: "fs.write",
    description: "파일에 내용을 쓴다(덮어쓴다). 기존 파일 일부만 고칠 땐 fs.edit 을 써",
    params: {
      type: "object",
      properties: {
        path: { type: "string", description: "파일 경로. 없는 디렉토리는 만들어진다" },
        content: { type: "string", description: "파일 전체 내용" },
      },
      required: ["path", "content"],
    },
    readOnly: false,
    execute: async () => {
      throw new Error("fs.write 는 에이전트 루프가 확인을 받은 뒤 실행해야 하는 툴이야");
    },
    resultLimit: 1,
    summarize: (r) => {
      const res = r as FsWriteResult;
      return `저장됨: ${res.path} (${res.lines}줄)\n${res.preview}`;
    },
  },

  "fs.edit": {
    name: "fs.edit",
    description:
      "파일에서 정확히 일치하는 문자열을 바꾼다. old_string 은 파일 안에서 유일해야 해 — " +
      "겹치면 앞뒤 줄을 더 붙여 유일하게 만들거나 replace_all 을 써. 먼저 fs.read 로 실제 내용을 확인할 것",
    params: {
      type: "object",
      properties: {
        path: { type: "string", description: "파일 경로" },
        old_string: { type: "string", description: "바꿀 문자열 (공백·들여쓰기까지 정확히)" },
        new_string: { type: "string", description: "새 문자열" },
        replace_all: { type: "boolean", description: "일치하는 모든 곳을 바꿀지" },
      },
      required: ["path", "old_string", "new_string"],
    },
    readOnly: false,
    execute: async () => {
      throw new Error("fs.edit 은 에이전트 루프가 확인을 받은 뒤 실행해야 하는 툴이야");
    },
    resultLimit: 1,
    summarize: (r) => {
      const res = r as FsEditResult;
      return `${res.replaced}군데 수정됨\n${res.preview}`;
    },
  },

  "fs.list": {
    name: "fs.list",
    description: "디렉토리 내용을 나열한다",
    params: {
      type: "object",
      properties: { path: { type: "string", description: "디렉토리 경로" } },
      required: ["path"],
    },
    readOnly: true,
    execute: async (p) => fsApi.list(p["path"] as string),
    resultLimit: 50,
    summarize: (r) => summarizeEntries((r as FsEntry[]).slice(0, 50)),
  },

  "fs.glob": {
    name: "fs.glob",
    description:
      "패턴으로 파일을 찾는다. 최근 수정 순으로 돌려준다. .gitignore 는 자동으로 존중한다",
    params: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'glob 패턴. 예: "*.png", "src/**/*.ts"' },
        base: { type: "string", description: "탐색 시작 디렉토리. 기본 홈" },
      },
      required: ["pattern"],
    },
    readOnly: true,
    execute: async (p) => fsApi.glob(p["pattern"] as string, p["base"] as string | undefined),
    resultLimit: 50,
    summarize: (r) => {
      const paths = r as string[];
      if (paths.length === 0) return "일치하는 파일 없음";
      const shown = paths.slice(0, 50).join("\n");
      return paths.length > 50 ? `${shown}\n… 외 ${paths.length - 50}개` : shown;
    },
  },

  "fs.grep": {
    name: "fs.grep",
    description: "파일 내용을 정규식으로 검색한다. 파일:줄번호와 함께 돌려준다",
    params: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "정규식" },
        base: { type: "string", description: "탐색 시작 디렉토리. 기본 홈" },
        glob: { type: "string", description: '검색 대상을 좁히는 glob. 예: "*.ts"' },
        max_results: { type: "number", description: "최대 결과 수. 기본 200" },
      },
      required: ["pattern"],
    },
    readOnly: true,
    execute: async (p) =>
      fsApi.grep(
        p["pattern"] as string,
        p["base"] as string | undefined,
        p["glob"] as string | undefined,
        p["max_results"] as number | undefined
      ),
    resultLimit: 50,
    summarize: (r) => summarizeGrep((r as FsGrepHit[]).slice(0, 50)),
  },

  // ── 기억 ──────────────────────────────────────────────────────────────────
  // 세션이 끝나도 남는다. 관련 기억은 요청마다 자동으로 떠올려 컨텍스트에 붙으므로,
  // memory.search 는 자동 회상이 놓친 것을 모델이 직접 찾을 때만 쓴다.

  "memory.save": {
    name: "memory.save",
    description:
      "다음에도 알고 있어야 할 사실을 기억해둔다. 사용자의 취향·습관·이름·관계·" +
      "진행 중인 일처럼 오래 유효한 것만. 이번 대화에서만 쓸 임시 정보나 이미 끝난 일은 저장하지 마",
    params: {
      type: "object",
      properties: {
        content: { type: "string", description: "한 문장으로. 나중에 읽어도 뜻이 통하게 써" },
        kind: {
          type: "string",
          enum: ["fact", "preference", "project", "reference"],
          description: "fact=사실, preference=취향, project=진행 중인 일, reference=링크·자료",
        },
      },
      required: ["content"],
    },
    readOnly: false,
    execute: async (p) =>
      memoryApi.save(p["content"] as string, (p["kind"] as string | undefined) ?? "fact"),
    resultLimit: 1,
    summarize: (r) => `기억했어: ${(r as Memory).content}`,
  },

  "memory.search": {
    name: "memory.search",
    description: "예전에 기억해둔 것을 찾는다. 자동으로 떠오른 기억만으로 부족할 때만 써",
    params: {
      type: "object",
      properties: { query: { type: "string", description: "찾을 내용" } },
      required: ["query"],
    },
    readOnly: true,
    execute: async (p) => memoryApi.search(p["query"] as string),
    resultLimit: 5,
    summarize: (r) => {
      const found = r as Memory[];
      if (found.length === 0) return "기억에 없음";
      return found.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
    },
  },

  "airdrop.send": {
    name: "airdrop.send",
    description:
      "파일을 AirDrop 으로 보낼 수 있게 선택 시트를 연다. 받는 기기는 사용자가 시트에서 고른다 — " +
      "너는 보내지 못하고 준비만 해준다. 폴더는 안 되고 파일만 된다",
    params: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "보낼 파일 경로들. 확실하지 않으면 fs.glob 으로 먼저 찾아",
        },
      },
      required: ["paths"],
    },
    readOnly: false,
    execute: async (p) => airdropApi.send((p["paths"] as string[]) ?? []),
    resultLimit: 1,
    summarize: (r) =>
      `AirDrop 시트를 열었어 (파일 ${r as number}개). 받을 기기는 시트에서 골라줘.`,
  },

  // ── 하위 에이전트 ──────────────────────────────────────────────────────────

  "agent.delegate": {
    name: "agent.delegate",
    description:
      "긴 조사를 하위 에이전트에게 맡긴다. 하위 에이전트는 조회 툴만 쓰고 결과를 요약해 돌려주며, " +
      "그 과정은 이 대화의 컨텍스트를 먹지 않는다. 웹 검색을 여러 번 하거나 파일을 많이 뒤져야 할 때 써. " +
      "한두 번이면 끝나는 조회는 직접 해 — 맡기는 게 더 느리다",
    params: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "조사할 내용을 한 문단으로. 하위 에이전트는 이 대화를 못 보니 필요한 맥락을 다 적어",
        },
      },
      required: ["task"],
    },
    // 조사 자체는 부작용이 없지만 비싸다. 다른 호출과 같이 돌리지 않는다.
    readOnly: false,
    execute: virtual("agent.delegate"),
    resultLimit: 1,
    summarize: (r) => String(r),
  },

  // ── 계획 ──────────────────────────────────────────────────────────────────
  // 사용자용 todo.* 와 다르다. 이건 이번 요청을 끝내기 위한 에이전트 자신의
  // 단계 목록이고, 요청이 끝나면 사라진다. 루프가 상태를 들고 처리한다.

  "plan.set": {
    name: "plan.set",
    description:
      "여러 단계가 필요한 작업을 시작할 때 할 일 순서를 정한다. 단계마다 무엇을 할지 한 줄로 써. " +
      "도중에 계획이 바뀌면 다시 불러도 되고, 이미 끝낸 단계는 완료 상태가 유지돼. " +
      "한두 번의 툴 호출로 끝나는 단순한 요청에는 쓰지 마",
    params: {
      type: "object",
      properties: {
        steps: { type: "array", items: { type: "string" }, description: "단계 목록 (순서대로)" },
      },
      required: ["steps"],
    },
    readOnly: false,
    execute: virtual("plan.set"),
    resultLimit: 1,
    summarize: (r) => String(r),
  },

  "plan.complete": {
    name: "plan.complete",
    description: "계획의 한 단계를 완료 처리한다. 그 단계의 작업이 실제로 끝난 뒤에만 불러",
    params: {
      type: "object",
      properties: { index: { type: "number", description: "완료한 단계 번호 (1부터)" } },
      required: ["index"],
    },
    readOnly: false,
    execute: virtual("plan.complete"),
    resultLimit: 1,
    summarize: (r) => String(r),
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

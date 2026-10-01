// ── LLM ──────────────────────────────────────────────────────────────────────

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  /** native tool calling: assistant 가 요청한 툴 호출들 (OpenAI 형식 그대로 전송). */
  tool_calls?: WireToolCall[];
  /** native tool calling: 이 tool 메시지가 어느 호출의 결과인지. */
  tool_call_id?: string;
}

/** 서버로 오가는 OpenAI 형식의 툴 호출. arguments 는 JSON 문자열이다. */
export interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmParams {
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** llama.cpp GBNF grammar. 에이전트 JSON 출력을 강제해 파싱 실패를 뿌리에서 막는다. */
  grammar?: string;
  /** native tool calling 용 툴 스키마. 있으면 tool_choice:"auto" 로 함께 보낸다. */
  tools?: OpenAiToolSchema[];
}

/** 스트림 델타에 실려 오는 툴 호출 조각. arguments 는 여러 청크에 걸쳐 온다. */
export interface RawToolCallDelta {
  index: number;
  id?: string;
  name?: string;
  argumentsFragment?: string;
}

export interface LlmStreamChunk {
  content: string;
  done: boolean;
  /** 모델의 사고 과정(llama.cpp `reasoning_content`). 답변 본문이 아니다. */
  reasoning?: string;
  toolCalls?: RawToolCallDelta[];
  finishReason?: string | null;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export type ToolName =
  | "todo.list"
  | "todo.list_done"
  | "todo.add"
  | "todo.complete"
  | "schedule.list"
  | "schedule.add"
  | "schedule.delete"
  | "code.exec"
  | "web.search"
  | "web.scrape"
  | "file.upload"
  | "weather.get"
  | "game.start"
  | "fs.read"
  | "fs.write"
  | "fs.edit"
  | "fs.list"
  | "fs.glob"
  | "fs.grep"
  | "skill.read"
  /** 루프가 직접 처리하는 가상 툴 (execute 없음). */
  | "user.ask"
  | "plan.set"
  | "plan.complete"
  | "memory.save"
  | "memory.search"
  | "agent.delegate"
  | "airdrop.send";

/**
 * 툴 파라미터는 JSON Schema 로 기술한다. 이 스키마 하나가 두 곳에 쓰인다:
 * native tool calling 의 `tools` 배열, 그리고 json 폴백 모드의 프롬프트 텍스트.
 * (예전엔 프롬프트 문자열에 손으로 중복 기재해 registry 와 어긋날 수 있었다.)
 */
export interface JsonSchemaProp {
  type: "string" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: string[];
  items?: { type: string };
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProp>;
  required?: string[];
}

export interface OpenAiToolSchema {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

/** 모델이 요청한 툴 호출 하나 (arguments 파싱 완료). */
export interface ToolCall {
  id: string;
  name: string;
  params: Record<string, unknown>;
}

/**
 * 에이전트 한 턴의 결과. 툴 호출이 비어 있으면 `text` 가 최종 답변이다
 * (예전 `tool: "none"` 관례를 대체한다).
 */
export interface AgentTurn {
  text: string;
  toolCalls: ToolCall[];
}

// ── DB records ────────────────────────────────────────────────────────────────

export interface Todo {
  id: number;
  content: string;
  status: "open" | "done";
  priority: number | null;
  due_at: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface ScheduleEvent {
  id: number;
  title: string;
  start_at: string;
  end_at: string | null;
  notes: string | null;
  all_day: boolean;
  created_at: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ScrapResult {
  url: string;
  title: string;
  content: string;
}

export interface CodeExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
  truncated: boolean;
  image_data_url?: string;
}

export interface FsReadResult {
  /** `   12→내용` 형태로 줄번호가 붙은 본문. */
  content: string;
  total_lines: number;
  truncated: boolean;
}

/**
 * 쓰기·수정 결과. `preview` 는 파일을 되읽어 만든 증거다 — 모델이 "저장됨" 이라는
 * 자기 주장 대신 실제로 남은 내용을 보고 완료를 판단한다.
 */
export interface FsWriteResult {
  path: string;
  bytes: number;
  lines: number;
  preview: string;
}

export interface FsEditResult {
  replaced: number;
  preview: string;
}

export interface FsGrepHit {
  path: string;
  line_no: number;
  text: string;
}

export interface FsEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
}

/** 실제로 건드리기 전에 백엔드에 물어본 접근 판정. */
export type FsDecision =
  | { kind: "allow"; path: string }
  | { kind: "confirm"; path: string }
  | { kind: "deny"; path: string; reason: string };

export interface ExecHistoryItem {
  id: number;
  language: string;
  code: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  executed_at: string;
}

/** 사용자가 직접 쓴 지식 파일 하나. 내장 knowledge 와 같은 자리에 합류한다. */
export interface Skill {
  name: string;
  /** 한 줄 요약. 프롬프트의 스킬 목록에 이름과 함께 실린다. */
  description: string;
  keywords: string[];
  content: string;
}

/** 세션을 넘어 남는 기억 한 조각. */
export interface Memory {
  id: number;
  kind: string;
  content: string;
  created_at: string;
  use_count: number;
}

export interface ConversationMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
  /** 첨부 파일 JSON. 저장할 때 붙인 게 없으면 null. */
  attachments?: string | null;
  /** 답변에 딸린 도구 기록·계획 등 JSON(serializeMeta). 없으면 null. */
  meta?: string | null;
}

import type { PlanStep } from "./plan";

// ── Permissions ───────────────────────────────────────────────────────────────

/**
 * 확인 창에서 사용자가 고른 것.
 * (규칙 저장·판정은 permissions.ts 가 한다. 타입만 여기 둬 순환 import 를 피한다.)
 */
export type PermissionDecision = "allow_once" | "allow_session" | "allow_always" | "deny";

// ── Agent step ────────────────────────────────────────────────────────────────

export type StepStatus = "running" | "done" | "error";

export interface AgentStep {
  id: number;
  thought: string;
  tool: string; // ToolName | MCP tool name | "none"
  params: Record<string, unknown>;
  /** Raw result from tool execution (for UI display) */
  result: unknown;
  /** Compressed summary for LLM context */
  summary: string;
  status: StepStatus;
  errorMessage?: string;
  imageDataUrl?: string;
}

/** Emitted during the loop so React can show live progress */
export type LoopEvent =
  | { type: "step_start"; iteration: number }
  | { type: "step_done"; step: AgentStep }
  | { type: "step_error"; step: AgentStep }
  | { type: "thinking_token"; token: string }
  | { type: "streaming_token"; token: string }
  | { type: "plan_updated"; steps: PlanStep[] }
  /** 작업 중에 사용자가 덧붙인 말을 컨텍스트에 넣었다. `stepCount` 는 그때까지의 스텝 수. */
  | { type: "user_interjected"; stepCount: number }
  | { type: "done"; answer: string; steps: AgentStep[]; promptTokens?: number; tokensPerSecond?: number; plan?: PlanStep[] }
  | { type: "error"; message: string }
  | {
      type: "confirm_needed";
      /** 코드 실행이면 언어("python"/"shell"/...), 파일이면 "write"/"edit". */
      language: string;
      /** 사용자에게 보여줄 본문 — 실행할 코드, 또는 쓸 파일과 내용 미리보기. */
      code: string;
      isDangerous: boolean;
      dangerReason: string;
      /**
       * "이 세션 동안" / "항상" 을 고르면 저장될 규칙 키.
       * 위험 패턴에 걸린 건 규칙이 있어도 매번 물으므로 isDangerous 와 무관하다.
       */
      ruleKey: string;
      resolve: (decision: PermissionDecision) => void;
    }
  | { type: "clarify_needed"; question: string; options: string[]; resolve: (answer: string) => void };

// ── Cat state ─────────────────────────────────────────────────────────────────

export type CatEmotion =
  | "idle"
  | "curious"
  | "working"
  | "happy"
  | "proud"
  | "sleepy"
  | "sad"
  | "error"
  | "cozy";

// ── Agent step parsed from LLM ────────────────────────────────────────────────

export interface ParsedAgentStep {
  thought: string;
  tool: string; // ToolName | MCP tool name | "none"
  params: Record<string, unknown>;
  finalAnswer?: string;
  needsConfirm?: boolean;
  isDangerous?: boolean;
  dangerReason?: string;
}

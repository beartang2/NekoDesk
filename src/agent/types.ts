// ── LLM ──────────────────────────────────────────────────────────────────────

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
}

export interface LlmParams {
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  /** llama.cpp GBNF grammar. 에이전트 JSON 출력을 강제해 파싱 실패를 뿌리에서 막는다. */
  grammar?: string;
  /** 토큰별 확률(logprob)과 상위 후보를 같이 받는다. 판단 확신도 계산용. */
  top_logprobs?: number;
}

/** 생성된 토큰 하나의 확률과, 그 자리에서 모델이 고려한 상위 후보들. */
export interface TokenLogprob {
  token: string;
  logprob: number;
  top_logprobs: Array<{ token: string; logprob: number }>;
}

export interface LlmStreamChunk {
  content: string;
  done: boolean;
  logprobs?: TokenLogprob[];
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
  | "file"
  | "clipboard"
  | "math.eval"
  | "weather.get"
  | "game.start";

export interface ToolParamSchema {
  type: "string" | "number" | "boolean" | "array";
  required?: boolean;
  description?: string;
}

export interface ToolDef<TParams, TResult> {
  name: ToolName;
  description: string;
  params: Record<string, ToolParamSchema>;
  execute: (params: TParams) => Promise<TResult>;
  /** Max items to inject into LLM context */
  resultLimit: number;
  summarize: (result: TResult) => string;
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

export interface ExecHistoryItem {
  id: number;
  language: string;
  code: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  executed_at: string;
}

export interface ConversationMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

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
  /** 빠른 판단의 도구 선택 확신도(0~1). 재판단한 스텝이면 기준에 못 미친 값이다. */
  confidence?: number;
  decision?: ParsedAgentStep["decision"];
}

/** Emitted during the loop so React can show live progress */
export type LoopEvent =
  | { type: "step_start"; iteration: number }
  | { type: "step_done"; step: AgentStep }
  | { type: "step_error"; step: AgentStep }
  | { type: "thinking_token"; token: string }
  | { type: "streaming_token"; token: string }
  | { type: "done"; answer: string; steps: AgentStep[]; promptTokens?: number }
  | { type: "error"; message: string }
  | { type: "confirm_needed"; language: string; code: string; isDangerous: boolean; dangerReason: string; resolve: (ok: boolean) => void }
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
  /**
   * 빠른 판단의 도구 선택 확신도(0~1). 서버가 확률을 줬을 때만 있다.
   * decision 이 fallback 이면 기준에 못 미쳐 거절된 값이다.
   */
  confidence?: number;
  /**
   * 이 스텝을 어떻게 골랐나.
   * fast = 생각 없이 확률로 / fallback = 확률이 낮아 생각하는 방식으로 다시 / legacy = 처음부터 생각하는 방식
   */
  decision?: "fast" | "fallback" | "legacy";
}

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
}

export interface LlmStreamChunk {
  content: string;
  done: boolean;
}

// ── Tools ─────────────────────────────────────────────────────────────────────

export type ToolName =
  | "todo.list"
  | "todo.add"
  | "todo.complete"
  | "schedule.list"
  | "schedule.add"
  | "schedule.delete"
  | "code.exec"
  | "web.search"
  | "web.scrape"
  | "file.upload"
  | "weather.get";

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
}

/** Emitted during the loop so React can show live progress */
export type LoopEvent =
  | { type: "step_start"; iteration: number }
  | { type: "step_done"; step: AgentStep }
  | { type: "step_error"; step: AgentStep }
  | { type: "streaming_token"; token: string }
  | { type: "done"; answer: string; steps: AgentStep[] }
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
  | "error"
  | "cozy";

// ── Agent step parsed from LLM ────────────────────────────────────────────────

export interface ParsedAgentStep {
  thought: string;
  tool: string; // ToolName | MCP tool name | "none"
  params: Record<string, unknown>;
  finalAnswer?: string;
}

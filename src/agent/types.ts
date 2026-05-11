// ── LLM ──────────────────────────────────────────────────────────────────────

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
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
  | "memo.find"
  | "memo.add"
  | "todo.list"
  | "todo.add"
  | "todo.complete"
  | "schedule.list"
  | "schedule.add"
  | "github.overview"
  | "web.search"
  | "file.upload";

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

export interface Memo {
  id: number;
  content: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

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
  | { type: "error"; message: string };

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

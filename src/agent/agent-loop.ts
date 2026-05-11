import { agentStep, chatStream } from "./llm-client";
import { getTool } from "./tool-registry";
import { isMcpTool, executeMcpTool } from "./mcp-registry";
import { AgentContext } from "./agent-context";
import type { LlmMessage, AgentStep, LoopEvent, ToolName } from "./types";

const MAX_ITERATIONS = 10;

/**
 * Summarize MCP tool results for LLM context.
 * Surfaces status/error fields first so the LLM can detect failures
 * even when the full JSON is long.
 */
function summarizeMcpResult(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const lines: string[] = [];
    if ("status" in parsed) lines.push(`status: ${parsed["status"]}`);
    if ("error" in parsed && parsed["error"]) lines.push(`error: ${String(parsed["error"])}`);
    const header = lines.join("\n");
    const body = text.slice(0, 500);
    return header ? `${header}\n\n${body}` : body;
  } catch {
    return text.slice(0, 500);
  }
}


export async function* runAgentLoop(
  userInput: string,
  chatHistory: LlmMessage[]
): AsyncGenerator<LoopEvent> {
  const context = new AgentContext(userInput, chatHistory);
  let stepId = 0;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    yield { type: "step_start", iteration: i + 1 };

    // ── LLM: decide next action ─────────────────────────────────────────────
    let parsed;
    try {
      parsed = await agentStep(context.toMessages());
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `LLM 연결 실패: ${errMsg}` };
      return;
    }

    // ── Terminal condition: tool === "none" ──────────────────────────────────
    if (parsed.tool === "none" || parsed.finalAnswer) {
      const finalAnswer = parsed.finalAnswer ?? parsed.thought;

      // Stream the final answer character by character from the stored string
      // (agentStep already returned the full text; we yield it as tokens)
      const tokens = finalAnswer.split("");
      for (const token of tokens) {
        yield { type: "streaming_token", token };
      }

      yield {
        type: "done",
        answer: finalAnswer,
        steps: context.steps,
      };
      return;
    }

    // ── Execute tool ─────────────────────────────────────────────────────────
    const toolName = parsed.tool;

    const step: AgentStep = {
      id: ++stepId,
      thought: parsed.thought,
      tool: toolName,
      params: parsed.params,
      result: null,
      summary: "",
      status: "running",
    };

    try {
      if (isMcpTool(toolName)) {
        // MCP tool execution
        const text = await executeMcpTool(toolName, parsed.params);
        step.result = text;
        step.summary = summarizeMcpResult(text);
        step.status = "done";
      } else {
        // Static built-in tool
        const toolEntry = getTool(toolName as ToolName);
        const result = await toolEntry.execute(parsed.params);
        step.result = result;
        step.summary = toolEntry.summarize(result);
        step.status = "done";
      }
      context.addStep(step);
      yield { type: "step_done", step };
    } catch (err) {
      step.errorMessage = err instanceof Error ? err.message : String(err);
      step.status = "error";
      step.summary = `오류: ${step.errorMessage}`;
      context.addStep(step);
      yield { type: "step_error", step };
      // Continue the loop — let LLM decide what to do about the error
    }
  }

  // ── Max iterations reached: generate final answer with chat stream ────────
  const toolContext = context.buildToolContext();
  const finalMessages: LlmMessage[] = [
    ...chatHistory.slice(-6),
    { role: "user", content: userInput },
  ];

  let finalAnswer = "";
  try {
    for await (const chunk of chatStream(finalMessages, toolContext)) {
      if (chunk.content) {
        finalAnswer += chunk.content;
        yield { type: "streaming_token", token: chunk.content };
      }
      if (chunk.done) break;
    }
  } catch {
    finalAnswer = "최대 반복 횟수에 도달했어. 수집된 정보를 바탕으로 답할게.";
    yield { type: "streaming_token", token: finalAnswer };
  }

  yield { type: "done", answer: finalAnswer, steps: context.steps };
}

/**
 * Direct chat (no tool loop) — streams response tokens.
 */
export async function* runDirectChat(
  userInput: string,
  chatHistory: LlmMessage[]
): AsyncGenerator<LoopEvent> {
  const messages: LlmMessage[] = [
    ...chatHistory.slice(-12),
    { role: "user", content: userInput },
  ];

  let answer = "";
  try {
    for await (const chunk of chatStream(messages, "")) {
      if (chunk.content) {
        answer += chunk.content;
        yield { type: "streaming_token", token: chunk.content };
      }
      if (chunk.done) break;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "LLM 연결 실패";
    yield { type: "error", message: msg };
    return;
  }

  yield { type: "done", answer, steps: [] };
}

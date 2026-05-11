import type { AgentStep, LlmMessage } from "./types";

const MAX_CONTEXT_CHARS = 3000;

export class AgentContext {
  private readonly userInput: string;
  private readonly chatHistory: LlmMessage[];
  readonly steps: AgentStep[] = [];

  constructor(userInput: string, chatHistory: LlmMessage[]) {
    this.userInput = userInput;
    // Keep recent history only to stay within context budget
    this.chatHistory = chatHistory.slice(-6);
  }

  addStep(step: AgentStep): void {
    this.steps.push(step);
  }

  /** Build message list for the next agent LLM call */
  toMessages(): LlmMessage[] {
    const messages: LlmMessage[] = [
      ...this.chatHistory,
      { role: "user", content: this.userInput },
    ];

    // Append tool results from previous steps
    for (const step of this.steps) {
      messages.push({
        role: "assistant",
        content: JSON.stringify({
          thought: step.thought,
          tool: step.tool,
          params: step.params,
        }),
      });

      if (step.tool !== "none") {
        messages.push({
          role: "tool",
          content: `[${step.tool} 결과]\n${step.summary}`,
        });
      }
    }

    return messages;
  }

  /** Aggregate all tool summaries into a single context string for the final chat call */
  buildToolContext(): string {
    if (this.steps.length === 0) return "";

    const parts = this.steps
      .filter((s) => s.tool !== "none" && s.status === "done")
      .map((s) => `[${s.tool}]\n${s.summary}`);

    const joined = parts.join("\n\n");
    // Hard cap to avoid blowing the context budget
    return joined.slice(0, MAX_CONTEXT_CHARS);
  }

  /** Derive final cat emotion from what happened in the loop */
  deriveCatEmotion(): import("./types").CatEmotion {
    if (this.steps.some((s) => s.status === "error")) return "error";
    const successfulTools = this.steps.filter((s) => s.tool !== "none" && s.status === "done");
    if (successfulTools.length === 0) return "idle";
    // If a write operation succeeded, show proud/happy
    const writeTools = ["todo.add", "todo.complete", "schedule.add", "code.exec"];
    if (successfulTools.some((s) => writeTools.includes(s.tool))) return "happy";
    return "curious";
  }
}

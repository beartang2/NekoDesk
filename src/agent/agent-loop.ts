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


// ── Code safety check ─────────────────────────────────────────────────────────
// 읽기 전용 코드: needsConfirm = false → 자동 실행
// 쓰기/수정/삭제 코드: needsConfirm = true → 승인 필요
// 위험한 코드: isDangerous = true → 빨간 경고 표시

interface CodeSafetyResult {
  needsConfirm: boolean;
  isDangerous: boolean;
  reason: string;
}

function checkCodeSafety(code: string, language: string): CodeSafetyResult {
  // 언제나 위험 (isDangerous = true, 빨간 경고)
  const DANGER_PATTERNS: Array<[RegExp, string]> = [
    [/\brm\s+-[rf]{1,2}\w*\s/, "파일/디렉토리 강제 삭제"],
    [/\bsudo\b/, "관리자 권한 실행"],
    [/\bdd\b.*\bif=/, "디스크 직접 쓰기"],
    [/>\s*\/dev\/(?!null)/, "디바이스 직접 접근"],
    [/\bkillall?\b|\bpkill\b/, "프로세스 강제 종료"],
    [/\bshutdown\b|\breboot\b/, "시스템 종료/재시작"],
  ];

  for (const [pattern, reason] of DANGER_PATTERNS) {
    if (pattern.test(code)) return { needsConfirm: true, isDangerous: true, reason };
  }

  // 언어별 쓰기/수정/삭제 패턴 (승인 필요, 일반 경고)
  const SHELL_WRITE: Array<[RegExp, string]> = [
    [/\brm\b/, "파일 삭제"],
    [/\bmv\b/, "파일 이동"],
    [/\bcp\s/, "파일 복사"],
    [/\bmkdir\b/, "디렉토리 생성"],
    [/\btouch\s/, "파일 생성"],
    [/\bchmod\b|\bchown\b/, "권한 변경"],
    [/\bln\s/, "링크 생성"],
    [/>>\s*\S/, "파일 추가 쓰기"],
    [/(?<![>])\s>\s*(?!\/dev\/null)\S/, "파일 쓰기"],
    [/\bpip\s+install\b|\bconda\s+install\b|\bnpm\s+(install|i)\b|\byarn\s+add\b|\bbrew\s+install\b/, "패키지 설치"],
    [/\bcurl\b.*(?:-X\s+(?:POST|PUT|PATCH|DELETE)|--data\b|-d\s)/, "HTTP 쓰기 요청"],
    [/\bwget\b.*-O\s*\S/, "파일 다운로드"],
    [/\bscp\b|\brsync\b/, "원격 파일 전송"],
  ];

  const PYTHON_WRITE: Array<[RegExp, string]> = [
    [/open\s*\([^)]*['"]\s*[waxWAX]/, "파일 쓰기"],
    [/\bos\s*\.\s*(?:remove|unlink|rmdir|makedirs|mkdir|rename|replace|symlink)\s*\(/, "파일 시스템 변경"],
    [/\bshutil\s*\.\s*(?:copy|move|rmtree|copytree|copyfile)\s*\(/, "파일 복사/삭제"],
    [/\bsubprocess\s*\.\s*(?:run|call|Popen|check_output|check_call)\s*\(/, "외부 프로세스 실행"],
    [/\bos\s*\.\s*system\s*\(/, "시스템 명령 실행"],
    [/\.write(?:_text|_bytes)?\s*\(/, "파일 쓰기"],
    [/requests\s*\.\s*(?:post|put|patch|delete)\s*\(/i, "HTTP 쓰기 요청"],
  ];

  const APPLESCRIPT_WRITE: Array<[RegExp, string]> = [
    [/\bset\s+\w.*\bto\b/, "값 설정"],
    [/\bmake\s+new\b/, "항목 생성"],
    [/\bdelete\b/, "항목 삭제"],
    [/\bmove\b/, "항목 이동"],
    [/\bduplicate\b/, "항목 복제"],
  ];

  const writePatterns =
    language === "python"      ? PYTHON_WRITE :
    language === "applescript" ? APPLESCRIPT_WRITE :
                                 SHELL_WRITE;

  for (const [pattern, reason] of writePatterns) {
    if (pattern.test(code)) return { needsConfirm: true, isDangerous: false, reason };
  }

  // 읽기 전용 → 자동 실행
  return { needsConfirm: false, isDangerous: false, reason: "" };
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

    // ── Confirm code execution (쓰기/수정/삭제만 승인, 읽기는 자동 실행) ────────
    if (toolName === "code.exec") {
      const code = (parsed.params["code"] as string) ?? "";
      const language = (parsed.params["language"] as string) ?? "python";

      const { needsConfirm, isDangerous, reason } = checkCodeSafety(code, language);

      if (needsConfirm) {
        let resolveConfirm!: (ok: boolean) => void;
        const approvalPromise = new Promise<boolean>((res) => { resolveConfirm = res; });
        yield { type: "confirm_needed", language, code, isDangerous, dangerReason: reason, resolve: resolveConfirm };
        const approved = await approvalPromise;

        if (!approved) {
          step.status = "error";
          step.errorMessage = "사용자가 실행을 취소했습니다";
          step.summary = "실행 취소됨";
          context.addStep(step);
          yield { type: "step_error", step };
          continue;
        }
      }
    }

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

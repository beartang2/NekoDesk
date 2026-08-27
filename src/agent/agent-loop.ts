import { agentTurnStream, chatStream } from "./llm-client";
import { getTool, isParallelSafe, isStaticTool } from "./tool-registry";
import { isMcpTool, executeMcpTool } from "./mcp-registry";
import { AgentContext, type ExecutedCall } from "./agent-context";
import { findDangerReason, isSafeReadOnly } from "./danger-patterns";
import { shouldUseNativeTools } from "../stores/settingsStore";
import type {
  AgentStep,
  AgentTurn,
  CodeExecResult,
  ContentPart,
  LlmMessage,
  LoopEvent,
  ToolCall,
  ToolName,
} from "./types";

const MAX_ITERATIONS = 10;

/** 사용자가 stop 을 눌렀다. 스스로 멈춘 것이니 에러 말풍선을 띄우지 않는다. */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/** LLM 서버가 응답하지 않아 타임아웃됐다. 이건 알려줘야 한다. */
function isTimeout(err: unknown): boolean {
  return err instanceof DOMException && err.name === "TimeoutError";
}

const ERROR_SEARCH_HINT = `\n\n[자동 힌트] web.search로 이 오류의 해결책을 찾아 재시도하세요. 검색 쿼리에서 파일 경로·사용자명·API키 등 개인정보를 반드시 제거하고, 오류 메시지 핵심만 사용하세요.`;

const APPLESCRIPT_ERROR_HINT = `\n\n[AppleScript 오류 힌트]
1. osascript -e '...' 래퍼를 사용했다면 즉시 제거하고 순수 AppleScript 코드만 작성해서 재시도해. (올바른 예: set volume output volume 30)
2. 시스템 프롬프트의 "## 참고 지식" 섹션에 올바른 AppleScript 문법이 있으니 반드시 확인해.
3. web.search는 참고 지식으로 해결이 안 될 때만 사용해.`;

/** 개인정보(홈 경로·사용자명·자격증명)를 지운다. 오류 메시지를 모델·검색에 넘기기 전. */
function sanitize(text: string): string {
  return text
    .replace(/\/Users\/[^/\s]+/g, "/Users/<user>")
    .replace(/\/home\/[^/\s]+/g, "/home/<user>")
    .replace(/[A-Za-z]:\\Users\\[^\\]+/g, "C:\\Users\\<user>")
    .replace(/(?:Bearer|token|key|secret|password)[=:\s]+\S+/gi, "<redacted>");
}

/** LLM 전용 힌트 문단을 제거하고 '오류 요약:' 줄만 남긴다 (사용자 표시용). */
function stripLlmHints(summary: string): string {
  const markers = ["\n\n[자동 힌트]", "\n\n[AppleScript 오류 힌트]"];
  for (const marker of markers) {
    const idx = summary.indexOf(marker);
    if (idx !== -1) {
      const before = summary.slice(0, idx);
      const after = summary.slice(idx);
      const errLine = after.match(/\n오류 요약: .+/);
      return errLine ? before + errLine[0] : before;
    }
  }
  return summary;
}

/**
 * code.exec 결과에서 오류를 감지하고, 있으면 LLM에게 힌트를 주입한다.
 * AppleScript 오류는 knowledge 재확인 힌트, 그 외는 web.search 힌트.
 */
function injectErrorSearchHint(
  summary: string,
  result: CodeExecResult,
  language?: string
): string {
  if (!result.exit_code) return summary;
  const rawErr = (result.stderr ?? result.stdout ?? "").trim().slice(0, 400);
  const hint = language === "applescript" ? APPLESCRIPT_ERROR_HINT : ERROR_SEARCH_HINT;
  return `${summary}${hint}\n오류 요약: ${sanitize(rawErr) || `exit_code=${result.exit_code}`}`;
}

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

// 위험 패턴 목록은 danger-patterns.ts 로 분리(테스트 대상). findDangerReason 사용.

function newStep(id: number, call: ToolCall, thought: string): AgentStep {
  return {
    id,
    thought,
    tool: call.name,
    params: call.params,
    result: null,
    summary: "",
    status: "running",
  };
}

/**
 * 툴 하나를 실행하고 결과를 스텝에 채운다. **던지지 않는다** — 실패도 스텝의
 * error 상태로 표현해야 여러 호출을 병렬로 돌릴 때 하나의 실패가 나머지를
 * 날려버리지 않는다.
 */
async function runCall(call: ToolCall, step: AgentStep): Promise<AgentStep> {
  try {
    if (isMcpTool(call.name)) {
      const text = await executeMcpTool(call.name, call.params);
      step.result = text;
      step.summary = summarizeMcpResult(text);
      step.status = "done";
      return step;
    }

    if (!isStaticTool(call.name)) {
      throw new Error(`없는 툴이야: ${call.name}`);
    }

    const entry = getTool(call.name as ToolName);
    const result = await entry.execute(call.params);
    step.result = result;
    step.summary = entry.summarize(result);
    step.status = "done";

    if (call.name === "code.exec") {
      const exec = result as CodeExecResult;
      // 이미지는 step 에 담고 summary 에선 뺀다 (base64 를 LLM 컨텍스트에 넣지 않는다).
      if (exec.image_data_url) {
        step.imageDataUrl = exec.image_data_url;
        step.summary += "\n[이미지 생성됨]";
      }
      step.summary = injectErrorSearchHint(
        step.summary,
        exec,
        call.params["language"] as string | undefined
      );
      if (exec.exit_code) step.status = "error";
    }
    return step;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    step.errorMessage = errMsg;
    step.status = "error";
    step.summary = `오류: ${sanitize(errMsg)}${ERROR_SEARCH_HINT}`;
    return step;
  }
}

/**
 * 같은 실패가 반복되는지 판별할 키. work_dir 같은 옵셔널 파라미터가 매번 달라도
 * 같은 실패로 인식되도록 code.exec 는 code+language 만 본다.
 */
function failureKey(step: AgentStep): string | null {
  if (step.status !== "error") return null;
  if (step.tool === "code.exec") {
    const code = (step.params["code"] as string) ?? "";
    const lang = (step.params["language"] as string) ?? "python";
    const exit = (step.result as CodeExecResult | null)?.exit_code ?? step.errorMessage;
    return `code.exec|${code}|${lang}|${exit}`;
  }
  return `${step.tool}|${JSON.stringify(step.params)}|${step.errorMessage ?? step.summary}`;
}

/** 최종 답변으로 쓸 텍스트. 모델이 아무 말도 안 했으면 알려준다. */
function finalAnswerOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  return "처리 중 문제가 생겼어. 다시 시도해줘.";
}

export async function* runAgentLoop(
  userInput: string,
  chatHistory: LlmMessage[],
  userContent?: string | ContentPart[],
  signal?: AbortSignal
): AsyncGenerator<LoopEvent> {
  // 모드는 루프 시작 시 한 번 고정한다. 중간에 강등되면 이미 쌓인 컨텍스트의
  // 메시지 형식과 어긋나므로, 강등은 다음 사용자 메시지부터 반영된다.
  const native = shouldUseNativeTools();
  const context = new AgentContext(chatHistory, userContent ?? userInput, native);
  let stepId = 0;
  let lastFailKey = ""; // 동일 실패 반복 감지용
  let latestPromptTokens: number | undefined;
  const trackUsage = (pts: number) => { latestPromptTokens = pts; };

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    yield { type: "step_start", iteration: i + 1 };

    // ── LLM: decide next action ─────────────────────────────────────────────
    // 답변 텍스트는 턴이 확정되기 전에 토큰 단위로 흘러나온다.
    let turn: AgentTurn | undefined;
    let streamedAnswer = "";
    try {
      for await (const ev of agentTurnStream(context.toMessages(), userInput, i, trackUsage, signal)) {
        if (ev.type === "thinking") {
          yield { type: "thinking_token", token: ev.text };
        } else if (ev.type === "delta") {
          streamedAnswer += ev.text;
          yield { type: "streaming_token", token: ev.text };
        } else {
          turn = ev.turn;
        }
      }
    } catch (err) {
      if (isAbort(err)) return;
      if (isTimeout(err)) {
        yield { type: "error", message: "LLM 서버가 응답하지 않아. llama.cpp 가 켜져 있는지 확인해줘." };
        return;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `LLM 연결 실패: ${errMsg}` };
      return;
    }
    if (!turn) {
      yield { type: "error", message: "LLM 응답을 해석하지 못했어. 다시 시도해줘." };
      return;
    }

    // ── Terminal condition: 툴 호출이 없으면 이번 턴의 텍스트가 최종 답변 ──────
    if (turn.toolCalls.length === 0) {
      const answer = finalAnswerOf(turn.text);
      // 스트리밍이 답의 앞부분만 흘렸다면 나머지만 이어붙인다.
      // 복구 파서가 전혀 다른 답을 냈다면 `done` 이벤트가 내용을 덮어써 자기교정한다.
      if (answer.startsWith(streamedAnswer) && answer.length > streamedAnswer.length) {
        yield { type: "streaming_token", token: answer.slice(streamedAnswer.length) };
      }
      yield { type: "done", answer, steps: context.steps, promptTokens: latestPromptTokens };
      return;
    }

    // ── Execute tool calls ───────────────────────────────────────────────────
    const calls = turn.toolCalls;
    const steps = calls.map((c) => newStep(++stepId, c, turn!.text));
    const executed: ExecutedCall[] = [];

    // 부작용 없는 조회는 동시에 돌린다. 나머지는 원래 순서대로 하나씩 —
    // 확인 다이얼로그·사용자 질문이 끼어들고, 앞 호출의 부작용에 의존할 수 있다.
    const parallelIdx = calls.map((_, idx) => idx).filter((idx) => isParallelSafe(calls[idx].name));
    if (parallelIdx.length > 1) {
      await Promise.all(parallelIdx.map((idx) => runCall(calls[idx], steps[idx])));
      for (const idx of parallelIdx) {
        executed.push({ call: calls[idx], step: steps[idx] });
        yield steps[idx].status === "error"
          ? { type: "step_error", step: steps[idx] }
          : { type: "step_done", step: steps[idx] };
      }
    }

    const sequentialIdx = calls
      .map((_, idx) => idx)
      .filter((idx) => !(parallelIdx.length > 1 && parallelIdx.includes(idx)));

    for (const idx of sequentialIdx) {
      const call = calls[idx];
      const step = steps[idx];

      // ── user.ask: 선택지로 사용자에게 질문 ────────────────────────────────
      if (call.name === "user.ask") {
        const question = (call.params["question"] as string) ?? "";
        const options = (call.params["options"] as string[]) ?? [];

        let resolveAnswer!: (answer: string) => void;
        const answerPromise = new Promise<string>((res) => { resolveAnswer = res; });
        yield { type: "clarify_needed", question, options, resolve: resolveAnswer };
        const answer = await answerPromise;

        step.result = answer;
        step.summary = `사용자 답변: ${answer}`;
        step.status = "done";
        executed.push({ call, step });
        yield { type: "step_done", step };
        continue;
      }

      // ── Confirm code execution ──────────────────────────────────────────────
      // code.exec 는 임의 코드를 사용자 권한으로 돌린다. 신뢰 경계를 모델의 판단에
      // 맡길 수 없다(web.scrape 로 프롬프트 인젝션 가능). 따라서 기본적으로 확인을
      // 요구하고(fail-safe), 안전하다고 알려진 좁은 경우에만 확인을 건너뛴다.
      if (call.name === "code.exec") {
        const code = (call.params["code"] as string) ?? "";
        const language = (call.params["language"] as string) ?? "python";

        const dangerReason = findDangerReason(code);
        const isDangerous = dangerReason !== undefined;
        if (isDangerous || !isSafeReadOnly(code, language)) {
          let resolveConfirm!: (ok: boolean) => void;
          const approvalPromise = new Promise<boolean>((res) => { resolveConfirm = res; });
          yield {
            type: "confirm_needed",
            language,
            code,
            isDangerous,
            dangerReason: dangerReason ?? "",
            resolve: resolveConfirm,
          };

          if (!(await approvalPromise)) {
            step.status = "error";
            step.errorMessage = "사용자가 실행을 취소했습니다";
            step.summary = "실행 취소됨";
            executed.push({ call, step });
            context.addTurn({ text: turn.text, calls: executed });
            yield { type: "step_error", step };
            const cancelMsg = "실행을 취소했어.";
            yield { type: "streaming_token", token: cancelMsg };
            yield { type: "done", answer: cancelMsg, steps: context.steps, promptTokens: latestPromptTokens };
            return;
          }
        }
      }

      await runCall(call, step);
      executed.push({ call, step });
      yield step.status === "error"
        ? { type: "step_error", step }
        : { type: "step_done", step };
    }

    context.addTurn({ text: turn.text, calls: executed });

    // ── 같은 실패의 반복이면 중단 ────────────────────────────────────────────
    // 모델이 똑같은 코드를 무한정 재시도하며 컨텍스트만 태우는 것을 막는다.
    const failures = executed.map((e) => failureKey(e.step)).filter((k): k is string => k !== null);
    const repeated = failures.find((k) => k === lastFailKey);
    if (repeated) {
      const failedStep = executed.find((e) => failureKey(e.step) === repeated)!.step;
      const msg = `같은 오류가 반복되어 중단했어.\n\n${stripLlmHints(failedStep.summary)}`;
      yield { type: "streaming_token", token: msg };
      yield { type: "done", answer: msg, steps: context.steps, promptTokens: latestPromptTokens };
      return;
    }
    lastFailKey = failures[0] ?? "";
  }

  // ── Max iterations reached: generate final answer with chat stream ────────
  const toolContext = context.buildToolContext();
  const finalMessages: LlmMessage[] = [
    ...chatHistory.slice(-6),
    { role: "user", content: userInput },
  ];

  let finalAnswer = "";
  try {
    for await (const chunk of chatStream(finalMessages, toolContext, trackUsage, signal)) {
      if (chunk.content) {
        finalAnswer += chunk.content;
        yield { type: "streaming_token", token: chunk.content };
      }
      if (chunk.done) break;
    }
  } catch (err) {
    if (isAbort(err)) return;
    finalAnswer = "최대 반복 횟수에 도달했어. 수집된 정보를 바탕으로 답할게.";
    yield { type: "streaming_token", token: finalAnswer };
  }

  yield { type: "done", answer: finalAnswer, steps: context.steps, promptTokens: latestPromptTokens };
}

/**
 * Direct chat (no tool loop) — streams response tokens.
 */
export async function* runDirectChat(
  userInput: string,
  chatHistory: LlmMessage[],
  signal?: AbortSignal
): AsyncGenerator<LoopEvent> {
  const messages: LlmMessage[] = [
    ...chatHistory.slice(-12),
    { role: "user", content: userInput },
  ];

  let directPromptTokens: number | undefined;
  let answer = "";
  try {
    for await (const chunk of chatStream(messages, "", (pts) => { directPromptTokens = pts; }, signal)) {
      if (chunk.content) {
        answer += chunk.content;
        yield { type: "streaming_token", token: chunk.content };
      }
      if (chunk.done) break;
    }
  } catch (err) {
    if (isAbort(err)) return;
    const msg = err instanceof Error ? err.message : "LLM 연결 실패";
    yield { type: "error", message: msg };
    return;
  }

  yield { type: "done", answer, steps: [], promptTokens: directPromptTokens };
}

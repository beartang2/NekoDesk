import { agentStep, agentStepStream, chatStream } from "./llm-client";
import { getTool, validateToolParams, ToolParamError } from "./tool-registry";
import { isMcpTool, executeMcpTool } from "./mcp-registry";
import { AgentContext } from "./agent-context";
import { findDangerReason, isSafeReadOnly } from "./danger-patterns";
import type { ContentPart, LlmMessage, AgentStep, LoopEvent, ToolName, ParsedAgentStep } from "./types";

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

/** 파라미터 검증 실패용. 웹 검색이 아니라 params 수정으로 유도한다. */
const PARAM_FIX_HINT = `\n\n[자동 힌트] 웹 검색하지 말고 params를 고쳐서 같은 툴을 다시 호출하세요. 위에 적힌 필드만 정확히 채우면 됩니다.`;

const APPLESCRIPT_ERROR_HINT = `\n\n[AppleScript 오류 힌트]
1. osascript -e '...' 래퍼를 사용했다면 즉시 제거하고 순수 AppleScript 코드만 작성해서 재시도해. (올바른 예: set volume output volume 30)
2. 시스템 프롬프트의 "## 참고 지식" 섹션에 올바른 AppleScript 문법이 있으니 반드시 확인해.
3. web.search는 참고 지식으로 해결이 안 될 때만 사용해.`;

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
 * 개인정보(경로, 사용자명)를 제거한 오류 요약을 힌트에 포함한다.
 */
function injectErrorSearchHint(summary: string, result: string, language?: string): string {
  try {
    const r = JSON.parse(result) as { exit_code?: number; stderr?: string; stdout?: string };
    if (!r.exit_code || r.exit_code === 0) return summary;

    // 개인정보 제거: 파일 경로, 사용자명, 홈 디렉토리
    const rawErr = (r.stderr ?? r.stdout ?? "").trim().slice(0, 400);
    const sanitized = rawErr
      .replace(/\/Users\/[^/\s]+/g, "/Users/<user>")
      .replace(/\/home\/[^/\s]+/g, "/home/<user>")
      .replace(/[A-Za-z]:\\Users\\[^\\]+/g, "C:\\Users\\<user>")
      .replace(/(?:Bearer|token|key|secret|password)[=:\s]+\S+/gi, "<redacted>");

    const hint = language === "applescript" ? APPLESCRIPT_ERROR_HINT : ERROR_SEARCH_HINT;
    return `${summary}${hint}\n오류 요약: ${sanitized || `exit_code=${r.exit_code}`}`;
  } catch {
    return summary;
  }
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

export async function* runAgentLoop(
  userInput: string,
  chatHistory: LlmMessage[],
  userContent?: string | ContentPart[],
  signal?: AbortSignal
): AsyncGenerator<LoopEvent> {
  const context = new AgentContext(userInput, chatHistory, userContent);
  let stepId = 0;
  let lastFailKey = ""; // 동일 실패 반복 감지용
  let latestPromptTokens: number | undefined;
  const trackUsage = (pts: number) => { latestPromptTokens = pts; };

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    yield { type: "step_start", iteration: i + 1 };

    // ── LLM: decide next action ─────────────────────────────────────────────
    // finalAnswer 는 JSON 이 완성되기 전에 토큰 단위로 흘러나온다.
    let parsed: ParsedAgentStep | undefined;
    let streamedAnswer = "";
    try {
      for await (const ev of agentStepStream(context.toMessages(), userInput, trackUsage, signal)) {
        if (ev.type === "thinking") {
          yield { type: "thinking_token", token: ev.text };
        } else if (ev.type === "delta") {
          streamedAnswer += ev.text;
          yield { type: "streaming_token", token: ev.text };
        } else {
          parsed = ev.parsed;
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
    if (!parsed) {
      yield { type: "error", message: "LLM 응답을 해석하지 못했어. 다시 시도해줘." };
      return;
    }

    // ── Terminal condition: tool === "none" ──────────────────────────────────
    if (parsed.tool === "none" || parsed.finalAnswer) {
      const finalAnswer = parsed.finalAnswer ?? (parsed.thought.length < 300 ? parsed.thought : "처리 중 문제가 생겼어. 다시 시도해줘.");

      // 스트리밍이 답의 앞부분만 흘렸다면 나머지만 이어붙인다.
      // 복구 파서가 전혀 다른 답을 냈다면 `done` 이벤트가 내용을 덮어써 자기교정한다.
      if (finalAnswer.startsWith(streamedAnswer) && finalAnswer.length > streamedAnswer.length) {
        yield { type: "streaming_token", token: finalAnswer.slice(streamedAnswer.length) };
      }

      yield {
        type: "done",
        answer: finalAnswer,
        steps: context.steps,
        promptTokens: latestPromptTokens,
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
      confidence: parsed.confidence,
      decision: parsed.decision,
    };

    // ── user.ask: 선택지로 사용자에게 질문 ────────────────────────────────────
    if (toolName === "user.ask") {
      const question = (parsed.params["question"] as string) ?? "";
      const options = (parsed.params["options"] as string[]) ?? [];

      let resolveAnswer!: (answer: string) => void;
      const answerPromise = new Promise<string>((res) => { resolveAnswer = res; });
      yield { type: "clarify_needed", question, options, resolve: resolveAnswer };
      const answer = await answerPromise;

      step.result = answer;
      step.summary = `사용자 답변: ${answer}`;
      step.status = "done";
      context.addStep(step);
      yield { type: "step_done", step };
      continue;
    }

    // ── Confirm code execution ────────────────────────────────────────────────
    // code.exec 는 임의 코드를 사용자 권한으로 돌린다. 신뢰 경계를 모델의
    // needsConfirm 필드에 맡길 수 없다(web.scrape 로 프롬프트 인젝션 가능).
    // 따라서 기본적으로 확인을 요구하고(fail-safe), 안전하다고 알려진 좁은
    // 경우에만 확인을 건너뛴다.
    if (toolName === "code.exec") {
      const code = (parsed.params["code"] as string) ?? "";
      const language = (parsed.params["language"] as string) ?? "python";

      const dangerReasonMatch = findDangerReason(code);
      const isDangerous = dangerReasonMatch !== undefined;
      // 위험 패턴에 걸리지 않아도 기본은 확인. 모델이 needsConfirm:false 를 줘도
      // 이 기본값을 뒤집지 못한다. 예외: AppleScript 알림·읽기 전용 정보 조회 등
      // 부작용 없는 코드는 isSafeReadOnly 로 걸러 확인을 생략한다.
      const needsConfirm = isDangerous || !isSafeReadOnly(code, language);
      const dangerReason = dangerReasonMatch ?? (parsed.dangerReason ?? "");

      if (needsConfirm) {
        let resolveConfirm!: (ok: boolean) => void;
        const approvalPromise = new Promise<boolean>((res) => { resolveConfirm = res; });
        yield { type: "confirm_needed", language, code, isDangerous, dangerReason, resolve: resolveConfirm };
        const approved = await approvalPromise;

        if (!approved) {
          step.status = "error";
          step.errorMessage = "사용자가 실행을 취소했습니다";
          step.summary = "실행 취소됨";
          context.addStep(step);
          yield { type: "step_error", step };
          const cancelMsg = "실행을 취소했어.";
          yield { type: "streaming_token", token: cancelMsg };
          yield { type: "done", answer: cancelMsg, steps: context.steps, promptTokens: latestPromptTokens };
          return;
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

        // GBNF 는 JSON 형태만 강제한다. 필수 필드 누락·타입 불일치·잘못된 enum
        // 값은 여기서 걸러야 실행 중에 터지지 않는다. 검증에 성공하면 기본값과
        // 형변환이 적용된 값을 쓴다.
        const safeParams = validateToolParams(toolEntry, parsed.params);

        const result = await toolEntry.execute(safeParams);
        step.result = result;
        step.summary = toolEntry.summarize(result);
        step.status = "done";

        // code.exec: 이미지 추출 + 오류 힌트 주입 + 반복 감지
        if (toolName === "code.exec") {
          const execResult = result as import("./types").CodeExecResult;

          // 이미지가 있으면 step에 저장하고 summary에서 제거 (LLM에 base64 노출 방지)
          if (execResult.image_data_url) {
            step.imageDataUrl = execResult.image_data_url;
            step.summary = step.summary + "\n[이미지 생성됨]";
          }

          const execLanguage = (parsed.params["language"] as string) ?? undefined;
          step.summary = injectErrorSearchHint(step.summary, JSON.stringify(execResult), execLanguage);

          const r = result as { exit_code?: number };
          if (r.exit_code && r.exit_code !== 0) {
            // work_dir 같은 옵셔널 파라미터 제외 — LLM이 매번 다르게 출력해도 동일 실패로 인식
            const codeKey = `${(parsed.params["code"] as string) ?? ""}||${(parsed.params["language"] as string) ?? "python"}`;
            const failKey = `${toolName}|${codeKey}|exit_code=${r.exit_code}`;
            if (failKey === lastFailKey) {
              step.status = "error";
              const msg = `같은 오류가 반복되어 중단했어.\n\n${stripLlmHints(step.summary)}`;
              context.addStep(step);
              yield { type: "step_error", step };
              yield { type: "streaming_token", token: msg };
              yield { type: "done", answer: msg, steps: context.steps, promptTokens: latestPromptTokens };
              return;
            }
            lastFailKey = failKey;
            context.addStep(step);
            yield { type: "step_done", step };
            continue;
          }
        }
      }
      context.addStep(step);
      yield { type: "step_done", step };
      lastFailKey = ""; // 성공 시 리셋
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const sanitizedErr = errMsg
        .replace(/\/Users\/[^/\s]+/g, "/Users/<user>")
        .replace(/\/home\/[^/\s]+/g, "/home/<user>");
      step.errorMessage = errMsg;
      step.status = "error";
      // 파라미터 오류는 웹에서 찾을 것이 없다. 검색 힌트 대신 교정 지시를 준다.
      step.summary =
        err instanceof ToolParamError
          ? `${sanitizedErr}${PARAM_FIX_HINT}`
          : `오류: ${sanitizedErr}${ERROR_SEARCH_HINT}`;
      context.addStep(step);
      yield { type: "step_error", step };

      // 동일 툴 + 동일 코드 + 동일 오류가 반복되면 즉시 중단
      const failKey = `${toolName}|${JSON.stringify(parsed.params)}|${step.errorMessage}`;
      if (failKey === lastFailKey) {
        const msg = `같은 오류가 반복되어 중단했어.\n\n${step.errorMessage}`;
        yield { type: "streaming_token", token: msg };
        yield { type: "done", answer: msg, steps: context.steps };
        return;
      }
      lastFailKey = failKey;
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

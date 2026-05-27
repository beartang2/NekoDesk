import { agentStep, chatStream } from "./llm-client";
import { getTool } from "./tool-registry";
import { isMcpTool, executeMcpTool } from "./mcp-registry";
import { AgentContext } from "./agent-context";
import type { ContentPart, LlmMessage, AgentStep, LoopEvent, ToolName } from "./types";

const MAX_ITERATIONS = 10;

// ── Korean → English macOS term fallback ──────────────────────────────────────
// code.exec 실행 시 한국어 키워드를 영어로 치환해서 먼저 시도한다.
const KO_TO_EN: Array<[RegExp, string]> = [
  // macOS 앱
  [/음악/g,           "Music"],
  [/팟캐스트/g,       "Podcasts"],
  [/사진/g,           "Photos"],
  [/미리 알림/g,      "Reminders"],
  [/캘린더/g,         "Calendar"],
  [/연락처/g,         "Contacts"],
  [/메시지/g,         "Messages"],
  [/메일/g,           "Mail"],
  [/파인더/g,         "Finder"],
  [/미리보기/g,       "Preview"],
  [/메모/g,           "Notes"],
  [/터미널/g,         "Terminal"],
  [/시스템 설정/g,    "System Settings"],
  [/시스템 환경설정/g,"System Preferences"],
  [/활성 상태 보기/g, "Activity Monitor"],
  [/디스크 유틸리티/g,"Disk Utility"],
  [/키체인 접근/g,    "Keychain Access"],
  // 폴더
  [/데스크탑/g,       "Desktop"],
  [/문서/g,           "Documents"],
  [/다운로드/g,       "Downloads"],
  [/응용 프로그램/g,  "Applications"],
  // 시스템 패널 키워드
  [/블루투스/g,       "Bluetooth"],
  [/디스플레이/g,     "Displays"],
  [/사운드/g,         "Sound"],
  [/네트워크/g,       "Network"],
  [/배터리/g,         "Battery"],
];

function hasKorean(text: string): boolean {
  return /[\uAC00-\uD7AF]/.test(text);
}

function translateToEnglish(code: string): string {
  let out = code;
  for (const [pattern, en] of KO_TO_EN) out = out.replace(pattern, en);
  return out;
}

const ERROR_SEARCH_HINT = `\n\n[자동 힌트] web.search로 이 오류의 해결책을 찾아 재시도하세요. 검색 쿼리에서 파일 경로·사용자명·API키 등 개인정보를 반드시 제거하고, 오류 메시지 핵심만 사용하세요.`;

const APPLESCRIPT_ERROR_HINT = `\n\n[AppleScript 오류 힌트]
1. osascript -e '...' 래퍼를 사용했다면 즉시 제거하고 순수 AppleScript 코드만 작성해서 재시도해. (올바른 예: set volume output volume 30)
2. 시스템 프롬프트의 "## 참고 지식" 섹션에 올바른 AppleScript 문법이 있으니 반드시 확인해.
3. web.search는 참고 지식으로 해결이 안 될 때만 사용해.`;

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
  chatHistory: LlmMessage[],
  userContent?: string | ContentPart[]
): AsyncGenerator<LoopEvent> {
  const context = new AgentContext(userInput, chatHistory, userContent);
  let stepId = 0;
  let lastFailKey = ""; // 동일 실패 반복 감지용

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    yield { type: "step_start", iteration: i + 1 };

    // ── LLM: decide next action ─────────────────────────────────────────────
    let parsed;
    try {
      parsed = await agentStep(context.toMessages(), userInput);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      yield { type: "error", message: `LLM 연결 실패: ${errMsg}` };
      return;
    }

    // ── Terminal condition: tool === "none" ──────────────────────────────────
    if (parsed.tool === "none" || parsed.finalAnswer) {
      const finalAnswer = parsed.finalAnswer ?? (parsed.thought.length < 300 ? parsed.thought : "처리 중 문제가 생겼어. 다시 시도해줘.");

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
          const cancelMsg = "실행을 취소했어.";
          yield { type: "streaming_token", token: cancelMsg };
          yield { type: "done", answer: cancelMsg, steps: context.steps };
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

        // code.exec: 한국어 키워드 → 영어로 먼저 시도, 실패 시 원본으로 재시도
        let execParams = parsed.params;
        if (toolName === "code.exec") {
          const code = (parsed.params["code"] as string) ?? "";
          if (hasKorean(code)) {
            const enCode = translateToEnglish(code);
            if (enCode !== code) {
              const enResult = await toolEntry.execute({ ...parsed.params, code: enCode });
              const enR = enResult as { exit_code?: number };
              if (!enR.exit_code || enR.exit_code === 0) {
                // 영어 버전 성공 → 그대로 사용
                step.result = enResult;
                step.summary = toolEntry.summarize(enResult);
                step.status = "done";
                context.addStep(step);
                yield { type: "step_done", step };
                lastFailKey = "";
                continue;
              }
              // 영어 실패 → 원본(한국어)으로 폴백
            }
          }
        }

        const result = await toolEntry.execute(execParams);
        step.result = result;
        step.summary = toolEntry.summarize(result);
        step.status = "done";

        // code.exec: exit_code != 0이면 검색 힌트 주입 + 반복 감지
        if (toolName === "code.exec") {
          const execLanguage = (parsed.params["language"] as string) ?? undefined;
          step.summary = injectErrorSearchHint(step.summary, result as string, execLanguage);

          const r = result as { exit_code?: number };
          if (r.exit_code && r.exit_code !== 0) {
            // work_dir 같은 옵셔널 파라미터 제외 — LLM이 매번 다르게 출력해도 동일 실패로 인식
            const codeKey = `${(parsed.params["code"] as string) ?? ""}||${(parsed.params["language"] as string) ?? "python"}`;
            const failKey = `${toolName}|${codeKey}|exit_code=${r.exit_code}`;
            if (failKey === lastFailKey) {
              step.status = "error";
              const msg = `같은 오류가 반복되어 중단했어.\n\n${step.summary}`;
              context.addStep(step);
              yield { type: "step_error", step };
              yield { type: "streaming_token", token: msg };
              yield { type: "done", answer: msg, steps: context.steps };
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
      step.summary = `오류: ${sanitizedErr}${ERROR_SEARCH_HINT}`;
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

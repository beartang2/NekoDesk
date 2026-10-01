import { agentTurnStream, chatStream, getModelContextLength } from "./llm-client";
import { FailureTracker } from "./failure-tracker";
import { Plan } from "./plan";
import { runSubagent } from "./subagent";
import { getTool, isParallelSafe, isStaticTool } from "./tool-registry";
import {
  addWriteRoot,
  execRuleKey,
  isAllowed,
  isAutoApprove,
  parentDir,
  remember,
  writeRuleKey,
} from "./permissions";
import { fsApi, memoryApi } from "../api/tauri";
import { isMcpTool, executeMcpTool } from "./mcp-registry";
import { AgentContext, type ExecutedCall } from "./agent-context";
import { findDangerReason, findExternalSendReason, isSafeReadOnly } from "./danger-patterns";
import { shouldUseNativeTools } from "../stores/settingsStore";
import type {
  AgentStep,
  AgentTurn,
  CodeExecResult,
  ContentPart,
  LlmMessage,
  LoopEvent,
  PermissionDecision,
  ToolCall,
  ToolName,
} from "./types";

/**
 * 루프 상한.
 *
 * 예전엔 반복 10회 하나뿐이라 다단계 작업이 중간에 잘렸다. 반복 수만으로는
 * "빠른 조회 40번" 과 "30초짜리 실행 10번" 을 구분할 수 없어, 시간과 호출 수도
 * 함께 본다. 셋 중 먼저 걸리는 것이 이긴다.
 */
const LIMITS = {
  iterations: 100,
  wallClockMs: 10 * 60_000,
  toolCalls: 100,
};

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

/**
 * 성공한 웹 조회를 똑같이 또 부르면 실행하지 않는다. 작은 모델은 결과를 보고도
 * "다른 방법을 찾아볼게" 하며 같은 검색을 되풀이해 답을 끝내 못 낸다. 실패 사다리는
 * 에러만 세므로 이 루프를 못 잡는다.
 * 웹만 대상이다 — 할 일·파일 목록 같은 조회는 중간에 바뀌어 다시 볼 이유가 있다.
 */
const DEDUPE_TOOLS = new Set(["web.search", "web.scrape"]);
const REPEAT_NOTE =
  "이미 똑같이 조회했어 — 결과는 앞에 있어. 같은 걸 다시 부르지 말고, 지금까지 찾은 정보로 답해.";
/** 반복이 이만큼 쌓이면 모델에게 더 맡기지 않고 모은 결과로 답을 만든다. */
const MAX_REPEATS = 2;

function callKey(call: ToolCall): string {
  return `${call.name}|${JSON.stringify(call.params).toLowerCase().replace(/\s+/g, " ")}`;
}

/**
 * 작업 중에 끼어든 말임을 모델에게 알린다. 그냥 user 메시지로만 넣으면 작은 모델은
 * 하던 일을 잊고 이 말에만 답한다. 시스템 프롬프트는 토큰 상한에 붙어 있어 여기에 싣는다.
 */
const INTERJECTION_NOTE =
  "[작업 중에 사용자가 덧붙인 말이야. 하던 일에 반영해. 별개의 요청이면 하던 일을 마친 뒤 함께 답해.]";

function asInterjection(content: string | ContentPart[]): string | ContentPart[] {
  return typeof content === "string"
    ? `${INTERJECTION_NOTE}\n${content}`
    : [{ type: "text", text: INTERJECTION_NOTE }, ...content];
}

function contentText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
}

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
async function runCall(call: ToolCall, step: AgentStep, approved = false): Promise<AgentStep> {
  try {
    // 쓰기 계열은 registry 의 execute 가 아니라 여기서 실행한다. `approved` 는
    // 모델이 정하는 파라미터가 아니라 루프가 사용자 확인을 받고 붙이는 값이라,
    // 모델이 채우는 params 를 통과시킬 수 없다.
    if (call.name === "fs.write") {
      const path = call.params["path"] as string;
      const result = await fsApi.write(path, (call.params["content"] as string) ?? "", approved);
      step.result = result;
      // 되읽은 내용을 함께 돌려준다. 백엔드가 이미 바이트 단위로 대조했지만,
      // 모델이 결과를 눈으로 봐야 "썼다" 를 근거 있게 말한다.
      step.summary = `저장됨: ${result.path} (${result.lines}줄, ${result.bytes}B)\n\n실제 저장된 내용:\n${result.preview}`;
      step.status = "done";
      return step;
    }
    if (call.name === "fs.edit") {
      const path = call.params["path"] as string;
      const result = await fsApi.edit(
        path,
        (call.params["old_string"] as string) ?? "",
        (call.params["new_string"] as string) ?? "",
        (call.params["replace_all"] as boolean) ?? false,
        approved
      );
      step.result = result;
      step.summary = `${path}: ${result.replaced}군데 수정됨\n\n수정 후 실제 내용:\n${result.preview}`;
      step.status = "done";
      return step;
    }

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
    // 승인 여부는 모델이 채우는 params 가 아니라 루프가 붙인다. 백엔드는 이 표시가
    // 없으면 code.exec 를 거부한다 — 게이트를 빠뜨린 경로가 조용히 실행되지 않도록.
    const params = call.name === "code.exec" ? { ...call.params, __approved: approved } : call.params;
    const result = await entry.execute(params);
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
 * 실행 전에 사용자 확인이 필요한 호출의 정보. null 이면 그냥 실행해도 되는 호출이다.
 */
interface Gate {
  /** 확인 창에 표시할 종류 — 코드면 언어, 파일이면 "write"/"edit". */
  language: string;
  /** 확인 창에 보여줄 본문. */
  preview: string;
  isDangerous: boolean;
  dangerReason: string;
  /** "세션 동안"/"항상" 을 고르면 저장될 규칙 키. */
  ruleKey: string;
  /** 파일 쓰기라면 승인 루트로 등록할 디렉토리. */
  writeDir?: string;
}

/** 하드 차단된 경로면 던진다 — 확인 창을 띄우는 것 자체가 잘못이다. */
async function buildGate(call: ToolCall): Promise<Gate | null> {
  if (call.name === "code.exec") {
    const code = (call.params["code"] as string) ?? "";
    const language = (call.params["language"] as string) ?? "python";
    const dangerReason = findDangerReason(code);
    const isDangerous = dangerReason !== undefined;
    if (!isDangerous && isSafeReadOnly(code, language)) return null;
    return {
      language,
      preview: code,
      isDangerous,
      dangerReason: dangerReason ?? "",
      ruleKey: execRuleKey(code, language),
    };
  }

  if (call.name !== "fs.write" && call.name !== "fs.edit") return null;

  const path = (call.params["path"] as string) ?? "";
  if (!path) throw new Error("path 파라미터가 없어");

  // 백엔드가 정책의 주인이다. 여기서 물어보는 건 확인 창을 띄울지 정하기 위해서다.
  const decision = await fsApi.check(path, true);
  if (decision.kind === "deny") throw new Error(decision.reason);
  if (decision.kind === "allow") return null; // 이미 승인된 쓰기 루트 안

  const kind = call.name === "fs.write" ? "write" : "edit";
  return {
    language: kind,
    preview: previewOf(call, decision.path),
    isDangerous: false,
    dangerReason: "",
    ruleKey: writeRuleKey(decision.path),
    writeDir: parentDir(decision.path),
  };
}

/** 확인 창에 보여줄 파일 변경 요약. 통째로 붙이면 긴 파일에서 창이 터진다. */
function previewOf(call: ToolCall, path: string): string {
  if (call.name === "fs.edit") {
    return [
      path,
      "",
      `- ${clip((call.params["old_string"] as string) ?? "")}`,
      `+ ${clip((call.params["new_string"] as string) ?? "")}`,
    ].join("\n");
  }
  return [path, "", clip((call.params["content"] as string) ?? "")].join("\n");
}

function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max}자 더)` : text;
}

/**
 * 이번 요청과 관련된 기억을 떠올려 한 덩이 문자열로 만든다.
 *
 * 검색어 분해(한국어 조사 처리 포함)와 랭킹은 백엔드가 한다. 실패해도 조용히
 * 빈 문자열을 돌려준다 — 기억이 없다고 대화를 못 할 이유는 없다.
 */
async function recallMemories(userInput: string): Promise<string> {
  try {
    const found = await memoryApi.search(userInput);
    return found.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
  } catch {
    return "";
  }
}

/** 최종 답변으로 쓸 텍스트. 모델이 아무 말도 안 했으면 알려준다. */
/**
 * 답이 같은 조각을 끝없이 되풀이하는 중인가. 맞으면 되풀이가 시작된 자리까지의 길이.
 *
 * 작은 모델은 낮은 온도에서 한 구절에 갇힌다("多少钱多少钱…"). 서버는 max_tokens 까지
 * 멈추지 않아서 2048 토큰을 다 쓰는 동안(4B 에서 약 2분) 사용자가 끼어들 수도 없었다.
 *
 * ponytail: 1~30자 조각이 8번 넘게 이어져 80자를 넘으면 반복으로 본다. 코드 속
 * `0, 0, 0, …` 같은 긴 배열도 걸릴 수 있다 — 그런 답이 실제로 잘리면 기준을 올린다.
 */
export function degenerateAt(text: string): number | null {
  const tail = text.slice(-600);
  const m = /(.{1,30}?)\1{7,}$/s.exec(tail);
  if (!m || m[0].length < 80) return null;
  return text.length - tail.length + m.index + m[1].length;
}

function finalAnswerOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  return "처리 중 문제가 생겼어. 다시 시도해줘.";
}

export async function* runAgentLoop(
  userInput: string,
  chatHistory: LlmMessage[],
  userContent?: string | ContentPart[],
  signal?: AbortSignal,
  /**
   * 일하는 사이 사용자가 보낸 말을 꺼내 온다(꺼내면 대기열에서 빠진다). 도구 실행이
   * 끝날 때마다 물어서, 있으면 다음 모델 호출에 싣는다. 답변이 흘러나오는 중에는
   * 끼울 자리가 없다 — 그건 부르는 쪽이 다음 요청으로 보낸다.
   */
  takeInterjections?: () => (string | ContentPart[])[],
  /**
   * 이 요청이 끝나기 전에 반드시 불려야 하는 툴. 부르지 않고 답하려 하면 한 번 더
   * 시킨다. 결과를 툴 인자로 받아야 하는 요청(끝말잇기 판정)에 쓴다 — 문장 속
   * 표시로 받으면 작은 모델이 "내가 졌어" 만 쓰고 표시를 빼먹었다.
   */
  requireTool?: ToolName,
  /**
   * 사용자가 보낸 말이 대기 중인가(꺼내지 않고 보기만 한다). 답이 흘러나오는 중에
   * 대기 말이 생기면 그 자리에서 답을 끊는다. 도구 사이에는 takeInterjections 로
   * 끼워 넣을 자리가 있지만, 답 도중에는 그런 자리가 없어 끝날 때까지 기다렸다.
   */
  hasInterjections?: () => boolean
): AsyncGenerator<LoopEvent> {
  // 모드는 루프 시작 시 한 번 고정한다. 중간에 강등되면 이미 쌓인 컨텍스트의
  // 메시지 형식과 어긋나므로, 강등은 다음 사용자 메시지부터 반영된다.
  const native = shouldUseNativeTools();
  const context = new AgentContext(
    chatHistory,
    userContent ?? userInput,
    native,
    getModelContextLength()
  );
  const failures = new FailureTracker();
  const plan = new Plan();
  // 이번 턴에 사용자가 거부한 규칙 키와 그 스텝. 거부는 모델에 돌려줘 다른 길을
  // 찾게 하되(Claude Code 방식), 같은 걸 또 들고 오면 그때는 끝낸다.
  const deniedThisTurn = new Set<string>();
  const deniedSteps = new Set<AgentStep>();
  const seenCalls = new Set<string>();
  let repeats = 0;
  let requiredCalled = false;
  let nudges = 0;
  // 끼어든 말의 글자 부분. 상한에 걸려 마지막 답을 따로 만들 때 질문에 붙인다.
  const interjectedTexts: string[] = [];

  // 관련 기억은 요청 시작 때 한 번만 떠올린다. 사용자 입력은 요청 안에서 안 바뀌므로
  // 턴마다 다시 검색할 이유가 없다(턴당 IPC 왕복 하나를 아낀다).
  // 기억이 없거나 조회에 실패해도 요청은 계속돼야 한다 — 부가 기능이지 전제가 아니다.
  const memories = await recallMemories(userInput);
  const startedAt = Date.now();
  let stepId = 0;
  let toolCallCount = 0;
  let latestPromptTokens: number | undefined;
  // 답변 아래 표시할 생성 속도. 마지막 호출(최종 답변을 만든 호출) 값을 쓴다.
  let latestTps: number | undefined;
  const trackUsage = (pts: number, tps?: number) => {
    latestPromptTokens = pts;
    if (tps) latestTps = tps;
  };

  for (let i = 0; i < LIMITS.iterations; i++) {
    if (Date.now() - startedAt > LIMITS.wallClockMs || toolCallCount >= LIMITS.toolCalls) break;
    yield { type: "step_start", iteration: i + 1 };

    // ── LLM: decide next action ─────────────────────────────────────────────
    // 답변 텍스트는 턴이 확정되기 전에 토큰 단위로 흘러나온다.
    let turn: AgentTurn | undefined;
    let streamedAnswer = "";
    // 생성 도중 끊은 이유. for-await 를 빠져나가면 스트림의 finally 가 연결을 닫아
    // llama.cpp 도 생성을 멈춘다.
    let cut: "interjected" | "repetition" | null = null;
    try {
      for await (const ev of agentTurnStream(context.toMessages(), userInput, i, memories, trackUsage, signal)) {
        if (ev.type === "thinking") {
          yield { type: "thinking_token", token: ev.text };
        } else if (ev.type === "delta") {
          streamedAnswer += ev.text;
          yield { type: "streaming_token", token: ev.text };
        } else {
          turn = ev.turn;
        }
        if (turn) continue;
        if (hasInterjections?.()) { cut = "interjected"; break; }
        if (ev.type === "delta" && degenerateAt(streamedAnswer) !== null) { cut = "repetition"; break; }
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
    if (cut) {
      // 끊긴 답도 답이다. 대기 중인 말은 부르는 쪽이 다음 요청으로 보낸다.
      const at = cut === "repetition" ? degenerateAt(streamedAnswer) : null;
      const kept = (at === null ? streamedAnswer : streamedAnswer.slice(0, at)).trim();
      const note = cut === "repetition" ? "(같은 말이 반복돼서 끊었어)" : "(말을 걸어서 여기서 멈췄어)";
      const answer = kept ? `${kept}\n\n${note}` : note;
      yield { type: "done", answer, steps: context.steps, promptTokens: latestPromptTokens, tokensPerSecond: latestTps, plan: plan.snapshot() };
      return;
    }
    if (!turn) {
      yield { type: "error", message: "LLM 응답을 해석하지 못했어. 다시 시도해줘." };
      return;
    }

    // ── Terminal condition: 툴 호출이 없으면 이번 턴의 텍스트가 최종 답변 ──────
    // ponytail: 재촉은 두 번까지. 그래도 안 부르면 그냥 끝낸다 — 무한히 붙잡는 것보다
    // 판정 없이 게임이 이어지는 쪽이 낫다.
    if (turn.toolCalls.length === 0 && requireTool && !requiredCalled && nudges < 2) {
      nudges++;
      context.addTurn({
        text: turn.text,
        calls: [],
        followUps: [`아직 ${requireTool} 를 안 불렀어. 말로만 하면 반영이 안 돼. 지금 ${requireTool} 를 불러서 결과를 정해.`],
      });
      continue;
    }
    if (turn.toolCalls.length === 0) {
      const answer = finalAnswerOf(turn.text);
      // 스트리밍이 답의 앞부분만 흘렸다면 나머지만 이어붙인다.
      // 복구 파서가 전혀 다른 답을 냈다면 `done` 이벤트가 내용을 덮어써 자기교정한다.
      if (answer.startsWith(streamedAnswer) && answer.length > streamedAnswer.length) {
        yield { type: "streaming_token", token: answer.slice(streamedAnswer.length) };
      }
      yield { type: "done", answer, steps: context.steps, promptTokens: latestPromptTokens, tokensPerSecond: latestTps, plan: plan.snapshot() };
      return;
    }

    if (turn.toolCalls.some((c) => c.name === requireTool)) requiredCalled = true;

    // ── Execute tool calls ───────────────────────────────────────────────────
    const lockedSteps: ExecutedCall[] = [];
    // 반복 조회는 실패 사다리 밖에 둔다. 성공으로 세면 잠긴 툴이 풀려버린다.
    const repeated: ExecutedCall[] = [];
    // 반복 실패로 잠긴 툴은 실행하지 않는다. 조용히 무시하면 모델은 아무 일도
    // 안 일어난 줄 알고 또 부르므로, 잠갔다는 사실을 결과로 돌려준다.
    const calls = turn.toolCalls.filter((c) => {
      if (seenCalls.has(callKey(c))) {
        const step = newStep(++stepId, c, turn!.text);
        step.status = "done";
        step.summary = REPEAT_NOTE;
        repeated.push({ call: c, step });
        repeats++;
        return false;
      }
      if (!failures.isLocked(c.name)) return true;
      const step = newStep(++stepId, c, turn!.text);
      step.status = "error";
      step.summary = `${c.name} 은 이번 요청에서 반복 실패해 잠겼어. 다른 방법을 써.`;
      lockedSteps.push({ call: c, step });
      return false;
    });
    const steps = calls.map((c) => newStep(++stepId, c, turn!.text));
    const executed: ExecutedCall[] = [...lockedSteps];
    toolCallCount += calls.length;
    for (const locked of lockedSteps) yield { type: "step_error", step: locked.step };
    for (const r of repeated) yield { type: "step_done", step: r.step };

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

      // ── agent.delegate: 조사를 하위 에이전트에게 ───────────────────────────
      // 하위 루프는 조회 툴만 쓴다(subagent.ts). 확인이 필요한 툴이 없으니
      // 여기서 이벤트를 UI 로 올릴 일도 없다.
      if (call.name === "agent.delegate") {
        const task = (call.params["task"] as string) ?? "";
        if (!task.trim()) {
          step.status = "error";
          step.summary = "오류: 조사할 내용(task)이 비어 있어";
        } else {
          step.summary = await runSubagent(task, signal);
          step.result = step.summary;
          step.status = "done";
        }
        executed.push({ call, step });
        yield step.status === "error"
          ? { type: "step_error", step }
          : { type: "step_done", step };
        continue;
      }

      // ── plan.*: 에이전트 자신의 작업 계획 ──────────────────────────────────
      // 루프가 상태를 들고 있다. 세션이 병렬로 도는 앱이라 모듈 전역에 두면
      // 두 대화의 계획이 서로를 덮어쓴다.
      if (call.name === "plan.set" || call.name === "plan.complete") {
        try {
          if (call.name === "plan.set") {
            plan.set((call.params["steps"] as string[]) ?? []);
          } else {
            plan.complete(Number(call.params["index"]));
          }
          step.result = plan.snapshot();
          // 매번 계획 전체를 되돌려준다 — 모델이 다음 턴에 자기 계획을 다시 읽는다.
          step.summary = plan.render();
          step.status = "done";
          yield { type: "plan_updated", steps: plan.snapshot() };
        } catch (err) {
          step.status = "error";
          step.errorMessage = err instanceof Error ? err.message : String(err);
          step.summary = `오류: ${step.errorMessage}`;
        }
        executed.push({ call, step });
        yield step.status === "error"
          ? { type: "step_error", step }
          : { type: "step_done", step };
        continue;
      }

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

      // ── 승인 게이트 ──────────────────────────────────────────────────────
      // code.exec 는 임의 코드를 사용자 권한으로 돌리고, fs.write/fs.edit 은 파일을
      // 바꾼다. 신뢰 경계를 모델의 판단에 맡길 수 없다(web.scrape 로 읽은 페이지가
      // 모델을 조종할 수 있다). 기본은 확인이고, 안전하다고 알려진 좁은 경우와
      // 사용자가 이미 승인해둔 규칙만 건너뛴다.
      let gate: Gate | null;
      try {
        gate = await buildGate(call);
      } catch (err) {
        // 하드 차단된 경로 등 — 판정 단계에서 이미 거부됐다.
        step.status = "error";
        step.errorMessage = err instanceof Error ? err.message : String(err);
        step.summary = `오류: ${step.errorMessage}`;
        executed.push({ call, step });
        yield { type: "step_error", step };
        continue;
      }

      // `approved` 의 뜻은 "사용자가 눌렀다" 가 아니라 **"승인 절차를 거쳤다"** 다.
      // 게이트가 확인이 필요 없다고 판단한 경우(부작용 없는 조회)도 거친 것이다.
      // 이 표시가 없는 호출은 게이트를 아예 안 지난 경로라는 뜻이라 백엔드가 막는다.
      let approved = gate === null;
      if (gate) {
        // 위험 패턴에 걸린 코드는 저장된 규칙이 있어도 매번 묻는다. 규칙을 만든
        // 주체가 사용자가 아니라 프롬프트 인젝션일 수 있다.
        // 오토모드도 같은 선을 넘지 않는다. 위험 패턴과 밖으로 내보내는 코드는 여전히 묻는다.
        const autoOk =
          isAutoApprove() &&
          !(call.name === "code.exec" && findExternalSendReason(gate.preview));
        if (!gate.isDangerous && (isAllowed(gate.ruleKey) || autoOk)) {
          approved = true;
        } else {
          // 방금 거부한 것을 또 들고 왔다 — "다른 방법" 이 아니다. 다시 묻지 않고 끝낸다.
          if (deniedThisTurn.has(gate.ruleKey)) {
            context.addTurn({ text: turn.text, calls: executed });
            const cancelMsg = "실행을 취소했어.";
            yield { type: "streaming_token", token: cancelMsg };
            yield { type: "done", answer: cancelMsg, steps: context.steps, promptTokens: latestPromptTokens, tokensPerSecond: latestTps, plan: plan.snapshot() };
            return;
          }
          let resolveConfirm!: (decision: PermissionDecision) => void;
          const decisionPromise = new Promise<PermissionDecision>((res) => { resolveConfirm = res; });
          yield {
            type: "confirm_needed",
            language: gate.language,
            code: gate.preview,
            isDangerous: gate.isDangerous,
            dangerReason: gate.dangerReason,
            ruleKey: gate.ruleKey,
            resolve: resolveConfirm,
          };
          const decision = await decisionPromise;

          if (decision === "deny") {
            // 예전엔 여기서 턴을 통째로 끝냈다. Claude Code 는 거부를 툴 결과로
            // 돌려준다 — "사용자가 거절했다. 같은 걸 그대로 다시 하지 말고 조정해라".
            // 그래야 모델이 다른 방법을 쓰거나, 왜 필요한지 설명하고 멈출 수 있다.
            deniedThisTurn.add(gate.ruleKey);
            deniedSteps.add(step);
            step.status = "error";
            step.errorMessage = "사용자가 실행을 거부했습니다";
            step.summary =
              "사용자가 이 실행을 거부했어. 같은 명령을 다시 시도하지 마. 다른 방법이 있으면 그걸 쓰고, 없으면 무엇이 왜 필요했는지 한 문장으로 말하고 멈춰.";
            executed.push({ call, step });
            yield { type: "step_error", step };
            continue;
          }

          approved = true;
          await remember(gate.ruleKey, decision);
          // "항상" 을 고른 쓰기는 백엔드의 승인 루트에도 넣는다. 그래야 다음부터
          // approved 플래그 없이도 통과한다.
          if (decision === "allow_always" && gate.writeDir) {
            await addWriteRoot(gate.writeDir);
          }
        }
      }

      await runCall(call, step, approved);
      executed.push({ call, step });
      yield step.status === "error"
        ? { type: "step_error", step }
        : { type: "step_done", step };
    }

    // ── 실패 사다리 ──────────────────────────────────────────────────────────
    // 같은 실패가 쌓이면 힌트 → 툴 잠금 → 중단 순으로 조인다. 힌트는 스텝 요약에
    // 붙어 컨텍스트로 들어가므로, 모델이 다음 턴에 "이미 뭘 시도했는지" 를 본다.
    let shouldStop = false;
    for (const { call, step } of executed) {
      if (step.status !== "error") {
        failures.recordSuccess(step.tool);
        if (DEDUPE_TOOLS.has(call.name)) seenCalls.add(callKey(call));
        continue;
      }
      // 거부는 실패가 아니다. 사다리에 올리면 "검색해서 해결책을 찾아라" 같은
      // 엉뚱한 힌트가 붙는다.
      if (deniedSteps.has(step)) continue;
      const advice = failures.record(step);
      if (advice.hint) step.summary += advice.hint;
      if (advice.stop) shouldStop = true;
    }

    // native 모드는 tool_call 마다 결과 메시지가 짝으로 있어야 하므로 반복분도 싣는다.
    context.addTurn({ text: turn.text, calls: [...executed, ...repeated] });

    if (shouldStop) {
      const msg = `같은 오류가 반복돼서 멈췄어. 지금까지 시도한 것:\n\n${failures.summary()}`;
      yield { type: "streaming_token", token: msg };
      yield { type: "done", answer: msg, steps: context.steps, promptTokens: latestPromptTokens, tokensPerSecond: latestTps, plan: plan.snapshot() };
      return;
    }
    if (repeats >= MAX_REPEATS) break;

    // ── 끼어든 말 ────────────────────────────────────────────────────────────
    // 도구 결과 바로 뒤가 유일하게 안전한 자리다. native 모드는 tool_call 과 결과가
    // 붙어 있어야 해서 그 사이에는 못 넣는다.
    const interjections = takeInterjections?.() ?? [];
    if (interjections.length > 0) {
      for (const content of interjections) {
        context.addFollowUp(asInterjection(content));
        interjectedTexts.push(contentText(content));
      }
      yield { type: "user_interjected", stepCount: context.steps.length };
    }
  }

  // ── 상한 도달 또는 반복 조회: 모은 결과로 최종 답변을 만든다 ────────────────
  const toolContext = context.buildToolContext();
  const finalMessages: LlmMessage[] = [
    ...chatHistory.slice(-6),
    { role: "user", content: [userInput, ...interjectedTexts].join("\n\n") },
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

  yield { type: "done", answer: finalAnswer, steps: context.steps, promptTokens: latestPromptTokens, tokensPerSecond: latestTps, plan: plan.snapshot() };
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
  let directTps: number | undefined;
  let answer = "";
  try {
    for await (const chunk of chatStream(messages, "", (pts, tps) => { directPromptTokens = pts; directTps = tps; }, signal)) {
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

  yield { type: "done", answer, steps: [], promptTokens: directPromptTokens, tokensPerSecond: directTps };
}

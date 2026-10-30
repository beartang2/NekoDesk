import type { AgentStep, CodeExecResult } from "./types";

/**
 * 반복 실패를 다루는 사다리.
 *
 * 예전에는 같은 실패가 두 번 나오면 즉시 루프를 끊었다. 안전하긴 한데, 모델이
 * 두 번째 시도에서 접근을 바꿀 기회조차 없었다 — 실제로는 "같은 코드를 또 냈다"
 * 는 사실만 알려주면 다르게 시도하는 경우가 많다. 그래서 단계를 둔다:
 *
 *   1회  기존 힌트만 (web.search 유도 등, agent-loop 가 이미 붙인다)
 *   2회  지금까지 시도한 것들을 요약해 보여주고 다른 접근을 요구
 *   3회  이번 요청에서 그 툴을 잠근다
 *   4회  중단
 *
 * 방법을 바꿔 가며 실패하는 경우(코드가 매번 달라 위 사다리에 안 걸린다)는 따로 본다.
 * 스킬을 읽고도 실패하면 모델은 추측으로 문법만 고쳐 보다가 두 번째쯤 포기했다
 * (Music 아트워크). 그래서 찾아보기 → 그래도 안 되면 멈추기를 정해 둔다:
 *
 *   검색 전 두 번째 실패       추측 말고 web.search 로 방법부터 찾으라고 한다
 *   검색 후 첫 실패            다르게 고치되, 확실한 방법이 없으면 멈추라고 한다
 *   검색 후 두 번째 실패       그 툴을 잠근다 — 모델은 막힌 이유를 말하고 끝낸다
 *
 * 서로 다른 실패가 계속 쌓이는 경우(매번 새로운 방식으로 실패)도 컨텍스트만
 * 태우므로 총량으로 따로 끊는다.
 */

/** 서로 다른 실패가 이만큼 쌓이면 방향을 잘못 잡은 것으로 본다. */
const MAX_TOTAL_FAILURES = 8;

/** 찾아보기 단계 밖에 두는 툴. 검색이 실패했는데 "검색해 봐" 라고 할 수는 없다. */
const SEARCH_TOOLS = new Set(["web.search", "web.scrape"]);

export interface FailureAdvice {
  /** 툴 결과에 덧붙여 모델에게 보여줄 문장. 없으면 빈 문자열. */
  hint: string;
  /** 이번 요청 동안 이 툴을 더 못 쓰게 잠갔는가. */
  toolLocked: boolean;
  /** 루프를 끝내야 하는가. */
  stop: boolean;
}

interface Attempt {
  tool: string;
  brief: string;
  error: string;
}

export class FailureTracker {
  private readonly counts = new Map<string, number>();
  private readonly attempts: Attempt[] = [];
  private readonly locked = new Set<string>();
  /** 툴별로 방법을 바꿔 가며 실패한 횟수, 그리고 그중 찾아본 뒤의 횟수. */
  private readonly toolFails = new Map<string, number>();
  private readonly failsAfterSearch = new Map<string, number>();
  /** 실패가 난 뒤 웹에서 찾아봤는가. */
  private searched = false;

  /** 이번 요청에서 잠긴 툴인가. */
  isLocked(tool: string): boolean {
    return this.locked.has(tool);
  }

  /** 성공한 호출은 그 툴의 실패 이력을 지운다 — 다시 시도할 자격을 준다. */
  recordSuccess(tool: string): void {
    this.locked.delete(tool);
    this.toolFails.delete(tool);
    this.failsAfterSearch.delete(tool);
    for (const key of [...this.counts.keys()]) {
      if (key.startsWith(`${tool}|`)) this.counts.delete(key);
    }
  }

  record(step: AgentStep): FailureAdvice {
    const key = failureKey(step);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    this.attempts.push({
      tool: step.tool,
      brief: briefOf(step),
      error: shortError(step),
    });

    if (count >= 4) {
      return { hint: "", toolLocked: this.locked.has(step.tool), stop: true };
    }
    if (this.attempts.length >= MAX_TOTAL_FAILURES) {
      return { hint: "", toolLocked: this.locked.has(step.tool), stop: true };
    }
    if (count === 3) {
      this.locked.add(step.tool);
      return {
        hint:
          `\n\n[반복 실패] ${step.tool} 로 세 번 시도했지만 같은 오류야. ` +
          `이 요청에서는 ${step.tool} 을 더 쓰지 마. 다른 툴로 해결하거나, 안 되면 왜 안 되는지 사용자에게 설명해.`,
        toolLocked: true,
        stop: false,
      };
    }
    if (count === 2) {
      return {
        hint:
          `\n\n[반복 실패] 방금과 같은 시도가 또 실패했어. 지금까지 시도한 것:\n` +
          `${this.historyLines()}\n` +
          `같은 걸 또 내지 말고 접근 자체를 바꿔 — 다른 툴, 다른 명령, 다른 경로.`,
        toolLocked: false,
        stop: false,
      };
    }
    return this.adviseOnNewAttempt(step.tool);
  }

  /** 웹 조회가 성공했다. 실패가 난 뒤라면 "찾아봤다" 로 친다. */
  recordSearch(): void {
    if (this.attempts.length > 0) this.searched = true;
  }

  /** 처음 보는 실패(방법을 바꿨는데 또 실패). 찾아봤는지에 따라 다음 길을 정해 준다. */
  private adviseOnNewAttempt(tool: string): FailureAdvice {
    const none = { hint: "", toolLocked: false, stop: false };
    if (SEARCH_TOOLS.has(tool)) return none;
    const n = (this.toolFails.get(tool) ?? 0) + 1;
    this.toolFails.set(tool, n);
    if (!this.searched) {
      if (n < 2) return none;
      return {
        ...none,
        hint:
          `\n\n[반복 실패] ${tool} 이 방법을 바꿔도 또 실패했어. 추측으로 다시 고치지 말고, ` +
          `오류 핵심으로 web.search 해서 맞는 방법(공식 문서·예제)부터 찾아.`,
      };
    }
    const m = (this.failsAfterSearch.get(tool) ?? 0) + 1;
    this.failsAfterSearch.set(tool, m);
    if (m >= 2) {
      this.locked.add(tool);
      return {
        hint:
          `\n\n[반복 실패] 찾아본 방법으로도 ${tool} 이 계속 실패해서 이 요청에서는 잠갔어. ` +
          `더 시도하지 말고, 무엇을 해봤고 어디서 막혔는지 사용자에게 말해.`,
        toolLocked: true,
        stop: false,
      };
    }
    return {
      ...none,
      hint:
        `\n\n[찾아본 뒤에도 실패] 검색한 방법으로도 안 됐어. 결과를 다시 읽고 다르게 고쳐. ` +
        `확실한 방법이 안 보이면 멈추고 막힌 이유를 사용자에게 말해.`,
    };
  }

  /** 사용자에게 보여줄 중단 사유. */
  summary(): string {
    return this.historyLines();
  }

  private historyLines(): string {
    // 최근 것부터 5개면 충분하다. 더 넣으면 힌트가 컨텍스트를 잡아먹는다.
    return this.attempts
      .slice(-5)
      .map((a) => `- ${a.tool}: ${a.brief} → ${a.error}`)
      .join("\n");
  }
}

/**
 * 같은 실패인지 판별할 키.
 *
 * code.exec 는 work_dir 같은 옵셔널 파라미터가 매번 달라질 수 있어 code+language
 * 만 본다. 그래야 "똑같은 코드를 또 냈다" 를 실제로 잡는다.
 */
export function failureKey(step: AgentStep): string {
  if (step.tool === "code.exec") {
    const code = (step.params["code"] as string) ?? "";
    const lang = (step.params["language"] as string) ?? "python";
    const exit = (step.result as CodeExecResult | null)?.exit_code ?? step.errorMessage ?? "";
    return `code.exec|${code}|${lang}|${exit}`;
  }
  return `${step.tool}|${JSON.stringify(step.params)}|${step.errorMessage ?? ""}`;
}

/** 시도 하나를 한 줄로 요약. 코드는 첫 줄만. */
function briefOf(step: AgentStep): string {
  if (step.tool === "code.exec") {
    const code = ((step.params["code"] as string) ?? "").trim();
    const firstLine = code.split("\n")[0] ?? "";
    return clip(firstLine, 80);
  }
  return clip(JSON.stringify(step.params), 80);
}

/** 힌트에 실을 짧은 오류. 자동 힌트 문단은 빼고 핵심만. */
function shortError(step: AgentStep): string {
  if (step.errorMessage) return clip(step.errorMessage, 120);
  const exec = step.result as CodeExecResult | null;
  const raw = (exec?.stderr || exec?.stdout || "").trim();
  if (raw) return clip(raw.split("\n").slice(-1)[0] ?? raw, 120);
  return clip(step.summary.split("\n")[0] ?? "실패", 120);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

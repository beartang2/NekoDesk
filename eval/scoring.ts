import type { ParsedAgentStep } from "../src/agent/types";
import { getTool, validateToolParams } from "../src/agent/tool-registry";
import type { ToolName } from "../src/agent/types";

/**
 * 에이전트 첫 스텝(어떤 도구를 어떤 값으로 부르려 했나)을 채점한다.
 * 도구를 실제로 실행하지 않으므로 음악 재생·파일 쓰기 같은 부작용이 없다.
 */

export interface Check {
  name: string;
  test: (step: ParsedAgentStep) => boolean;
  /** false 면 통과 판정에 반영하지 않고 참고용으로만 기록한다. */
  critical?: boolean;
}

export interface Expectation {
  /** 허용하는 도구. "none" 은 도구 없이 바로 답하는 경우. */
  tool: string;
  checks?: Check[];
}

export interface EvalCase {
  id: string;
  category: string;
  input: string;
  /** 하나라도 만족하면 도구 선택은 맞은 것으로 본다. */
  accept: Expectation[];
  note?: string;
}

export interface CheckResult {
  name: string;
  ok: boolean;
  critical: boolean;
}

export interface CaseScore {
  pass: boolean;
  toolOk: boolean;
  chosenTool: string;
  checks: CheckResult[];
}

const STATIC_TOOLS = new Set<string>([
  "todo.list", "todo.list_done", "todo.add", "todo.complete",
  "schedule.list", "schedule.add", "schedule.delete",
  "code.exec", "web.search", "web.scrape", "file.upload",
  "file", "clipboard", "math.eval", "weather.get", "game.start",
]);

export function scoreStep(step: ParsedAgentStep, testCase: EvalCase): CaseScore {
  const chosenTool = step.tool;
  const expectation = testCase.accept.find((e) => e.tool === chosenTool);

  if (!expectation) {
    return {
      pass: false,
      toolOk: false,
      chosenTool,
      checks: [{ name: `도구 선택 (${testCase.accept.map((e) => e.tool).join(" | ")})`, ok: false, critical: true }],
    };
  }

  const checks: CheckResult[] = [];

  // 앱은 실행 전에 zod 로 파라미터를 검증한다. 여기서 걸리면 실제로는 재시도가 한 번 더 든다.
  if (STATIC_TOOLS.has(chosenTool)) {
    let valid = true;
    try {
      validateToolParams(getTool(chosenTool as ToolName), step.params);
    } catch {
      valid = false;
    }
    checks.push({ name: "파라미터 스키마", ok: valid, critical: true });
  }

  for (const check of expectation.checks ?? []) {
    let ok = false;
    try {
      ok = check.test(step);
    } catch {
      ok = false;
    }
    checks.push({ name: check.name, ok, critical: check.critical ?? true });
  }

  return {
    pass: checks.every((c) => c.ok || !c.critical),
    toolOk: true,
    chosenTool,
    checks,
  };
}

// ── 체크 헬퍼 ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export const code = (step: ParsedAgentStep) => str(step.params["code"]);

export function language(lang: string): Check {
  return {
    name: `language = ${lang}`,
    test: (s) => (str(s.params["language"]) || "python") === lang,
  };
}

export function codeHas(name: string, pattern: RegExp): Check {
  return { name, test: (s) => pattern.test(code(s)) };
}

export function codeLacks(name: string, pattern: RegExp): Check {
  return { name, test: (s) => !pattern.test(code(s)) };
}

export function param(name: string, key: string, pattern: RegExp, critical = true): Check {
  return { name, critical, test: (s) => pattern.test(str(s.params[key])) };
}

export function paramEquals(key: string, value: unknown): Check {
  return { name: `${key} = ${JSON.stringify(value)}`, test: (s) => s.params[key] === value };
}

export function custom(name: string, test: (s: ParsedAgentStep) => boolean, critical = true): Check {
  return { name, test, critical };
}

/** AppleScript 에 파이썬 문법이 섞였는지. 작은 모델이 가장 자주 틀리는 지점이다. */
export const noPythonSyntax = codeLacks(
  "파이썬 문법 섞임 없음",
  /^\s*[A-Za-z_]\w*\s*=(?!=)|^\s*for\s+\w+\s+in\s+.+:\s*$|^\s*def\s+\w+\(|\[\s*"[^"]*"\s*,/m
);

export const noOsascriptWrapper = codeLacks("osascript -e 래퍼 없음", /osascript\s+-e/);

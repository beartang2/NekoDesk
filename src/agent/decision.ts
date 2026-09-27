import type { TokenLogprob } from "./types";

/**
 * 생각(thought) 없이 확률로 도구를 고르는 "빠른 판단" 모드.
 *
 * 문법(GBNF)으로 출력을 {"tool":"<허용된 이름>","params":{...}} 형태로 강제하고,
 * 도구 이름을 이루는 토큰들의 확률로 확신도를 계산한다. 생각 문장을 먼저 쓰지
 * 않으니 스텝마다 수십 토큰을 아끼고, 확신이 낮을 때만 예전 방식(생각 포함)으로
 * 다시 판단한다. SemIf/Jev 류의 "선택지 확률 읽기"를 지금 떠 있는 모델로 하는 것.
 */

/** 에이전트 JSON 의 값 규칙. 기존 에이전트 문법과 빠른 판단 문법이 함께 쓴다. */
export const JSON_RULES = `object ::= "{" ws ( string ":" ws value ("," ws string ":" ws value)* )? "}" ws
value  ::= object | array | string | number | ("true"|"false"|"null") ws
array  ::= "[" ws ( value ("," ws value)* )? "]" ws
string ::= "\\"" ( [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\bfnrt/] | "u" [0-9a-fA-F]{4}) )* "\\"" ws
number ::= ("-"? ([0-9] | [1-9][0-9]*)) ("." [0-9]+)? ([eE][-+]?[0-9]+)? ws
ws     ::= [ \\t\\n]*`;

/** 이보다 확신이 낮으면 생각하는 방식으로 다시 판단한다. */
export const FAST_DECISION_MIN_CONFIDENCE = 0.5;

/** 확신도 계산에 쓸 상위 후보 수. */
export const DECISION_TOP_LOGPROBS = 10;

/** 출력이 반드시 이 문자열로 시작한다. 공백을 허용하지 않아 토큰 경계가 흔들리지 않게 한다. */
const PREFIX = '{"tool":"';

function lit(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 도구 이름을 허용 목록으로 제한하는 문법.
 * "none" 이면 params 는 비우고 finalAnswer 를 반드시 쓰게 하고,
 * 그 외 도구면 finalAnswer 없이 params 만 쓰게 한다.
 */
export function buildDecisionGrammar(toolNames: string[]): string {
  const tools = toolNames.filter((n) => n !== "none");
  return [
    `root ::= ${lit('{"tool":"none","params":{},"finalAnswer":')} ws string "}" ws | ${lit(PREFIX)} tool ${lit('","params":')} ws object "}" ws`,
    `tool ::= ${tools.map(lit).join(" | ")}`,
    JSON_RULES,
  ].join("\n");
}

export interface Decision {
  tool: string;
  /** 0~1. 서버가 토큰 확률을 주지 않았으면 undefined. */
  confidence?: number;
}

/**
 * 스트리밍으로 들어오는 토큰 확률을 받아, 도구 이름이 완성되는 순간 확신도를 낸다.
 *
 * 확신도 = 도구 이름을 이루는 각 토큰에서
 *          (고른 토큰의 확률) / (그 자리에서 유효한 도구 이름으로 이어지는 후보들의 확률 합)
 * 을 곱한 값. 서버가 주는 확률은 문법을 적용하기 전(모델 원래 분포)이라, 허용된
 * 이름끼리 다시 정규화해야 "이 도구들 중에서 얼마나 확신하나"가 된다.
 * 강제된 접두부 {"tool":" 구간은 선택의 여지가 없으므로 계산에서 뺀다.
 */
export function createDecisionTracker(toolNames: string[]) {
  const targets = toolNames.map((n) => `${PREFIX}${n}"`);
  const consistent = (s: string) => targets.some((t) => t.startsWith(s) || s.startsWith(t));

  let text = "";
  let confidence = 1;
  let decided: Decision | null = null;
  let broken = false;

  return {
    push(entries: TokenLogprob[]): Decision | null {
      for (const entry of entries) {
        if (decided || broken) break;
        const next = text + entry.token;
        if (!consistent(next)) {
          // 서버가 일부 토큰의 확률을 빠뜨리면 재구성이 어긋난다. 확신도를 모르는 것으로 둔다.
          broken = true;
          break;
        }
        if (next.length > PREFIX.length) {
          const probs = new Map<string, number>([[entry.token, Math.exp(entry.logprob)]]);
          for (const c of entry.top_logprobs) {
            if (!consistent(text + c.token)) continue;
            probs.set(c.token, Math.max(probs.get(c.token) ?? 0, Math.exp(c.logprob)));
          }
          const total = [...probs.values()].reduce((a, b) => a + b, 0);
          if (total > 0) confidence *= Math.exp(entry.logprob) / total;
        }
        text = next;
        const hit = targets.find((t) => text.startsWith(t));
        if (hit) decided = { tool: hit.slice(PREFIX.length, -1), confidence };
      }
      return decided;
    },
  };
}

/** 생성된 텍스트에서 도구 이름이 완성됐는지 본다. 확률이 안 올 때의 대비책. */
export function toolFromPrefix(content: string): string | null {
  const m = content.match(/^\{"tool":"([^"]*)"/);
  return m ? m[1] : null;
}

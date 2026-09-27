import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentStep, checkLlmHealth, warmUpModel } from "../src/agent/llm-client";
import type { ParsedAgentStep } from "../src/agent/types";
import { CASES } from "./cases";
import { scoreStep, type CaseScore } from "./scoring";

/**
 * 실제 llama-server 에 실제 에이전트 프롬프트를 보내고 첫 스텝을 채점한다.
 *
 *   npm run eval                                  전체
 *   NEKO_EVAL_ONLY=음악 npm run eval              카테고리 또는 id 로 골라서
 *   NEKO_EVAL_RUNS=3 npm run eval                 케이스마다 여러 번 (흔들림 확인)
 *
 * 결과는 eval/results/ 에 JSON(원본 응답 포함)과 요약 마크다운으로 남는다.
 */

const RUNS = Math.max(1, Number(process.env.NEKO_EVAL_RUNS ?? 1));
const ONLY = (process.env.NEKO_EVAL_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const selected = ONLY.length
  ? CASES.filter((c) => ONLY.includes(c.id) || ONLY.includes(c.category))
  : CASES;

interface RunRecord {
  ms: number;
  promptTokens?: number;
  step?: ParsedAgentStep;
  score?: CaseScore;
  error?: string;
}

const records = new Map<string, RunRecord[]>();

beforeAll(async () => {
  if (!(await checkLlmHealth())) {
    throw new Error(
      `llama-server 에 연결할 수 없어 (${process.env.NEKO_EVAL_URL ?? "http://127.0.0.1:8803"}). ` +
      "앱에서 모델을 켜거나 NEKO_EVAL_URL 을 지정해줘."
    );
  }
  // 첫 케이스만 시스템 프롬프트 프리필(수 초)을 떠안지 않게 먼저 데운다.
  await warmUpModel();
});

describe("에이전트 첫 스텝", () => {
  for (const testCase of selected) {
    it(`[${testCase.category}] ${testCase.id}: ${testCase.input}`, async () => {
      const runs: RunRecord[] = [];
      for (let i = 0; i < RUNS; i++) {
        const started = performance.now();
        let promptTokens: number | undefined;
        try {
          const step = await agentStep(
            [{ role: "user", content: testCase.input }],
            testCase.input,
            (n) => { promptTokens = n; }
          );
          runs.push({ ms: performance.now() - started, promptTokens, step, score: scoreStep(step, testCase) });
        } catch (err) {
          runs.push({ ms: performance.now() - started, error: err instanceof Error ? err.message : String(err) });
        }
      }
      records.set(testCase.id, runs);

      const failed = runs.find((r) => !r.score?.pass);
      expect.soft(failed?.score?.checks.filter((c) => !c.ok && c.critical) ?? failed?.error ?? [], describeRun(failed)).toEqual([]);
    });
  }
});

afterAll(() => {
  if (records.size === 0) return;
  const report = buildReport();
  const dir = join(__dirname, "results");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  writeFileSync(join(dir, `${stamp}.json`), JSON.stringify(report.json, null, 2));
  writeFileSync(join(dir, "latest.md"), report.markdown);
  console.log(`\n${report.markdown}\n결과 저장: eval/results/${stamp}.json, eval/results/latest.md`);
});

function describeRun(run?: RunRecord): string {
  if (!run) return "";
  if (run.error) return `오류: ${run.error}`;
  const s = run.step!;
  return `선택: ${s.tool} ${JSON.stringify(s.params).slice(0, 300)}`;
}

function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

function buildReport() {
  const rows = selected
    .filter((c) => records.has(c.id))
    .map((c) => {
      const runs = records.get(c.id)!;
      const passed = runs.filter((r) => r.score?.pass).length;
      const toolOk = runs.filter((r) => r.score?.toolOk).length;
      const failures = [...new Set(runs.flatMap((r) =>
        r.error ? [`오류: ${r.error}`] : r.score!.checks.filter((k) => !k.ok).map((k) => (k.critical ? k.name : `(참고) ${k.name}`))
      ))];
      return {
        id: c.id,
        category: c.category,
        input: c.input,
        passed,
        toolOk,
        runs: runs.length,
        chosen: [...new Set(runs.map((r) => r.step?.tool ?? "오류"))].join(", "),
        medianMs: Math.round(median(runs.map((r) => r.ms))),
        failures,
        raw: runs,
      };
    });

  const totalRuns = rows.reduce((n, r) => n + r.runs, 0);
  const totalPass = rows.reduce((n, r) => n + r.passed, 0);
  const totalTool = rows.reduce((n, r) => n + r.toolOk, 0);
  const pct = (n: number) => `${Math.round((n / Math.max(1, totalRuns)) * 100)}%`;

  const categories = [...new Set(rows.map((r) => r.category))].map((cat) => {
    const rs = rows.filter((r) => r.category === cat);
    const runs = rs.reduce((n, r) => n + r.runs, 0);
    const pass = rs.reduce((n, r) => n + r.passed, 0);
    return `| ${cat} | ${pass}/${runs} | ${Math.round(median(rs.map((r) => r.medianMs)))}ms |`;
  });

  const markdown = [
    `# 네코 평가 결과 (${new Date().toLocaleString("ko-KR")})`,
    "",
    `- 통과: **${totalPass}/${totalRuns} (${pct(totalPass)})**`,
    `- 도구 선택 정확도: ${totalTool}/${totalRuns} (${pct(totalTool)})`,
    `- 케이스당 반복: ${RUNS}회`,
    "",
    "| 카테고리 | 통과 | 응답 시간(중앙값) |",
    "| --- | --- | --- |",
    ...categories,
    "",
    "| 케이스 | 통과 | 선택한 도구 | 응답 시간 | 실패 항목 |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((r) =>
      `| ${r.id} | ${r.passed}/${r.runs} | ${r.chosen} | ${r.medianMs}ms | ${r.failures.join("; ").replace(/\|/g, "\\|") || "-"} |`
    ),
  ].join("\n");

  return { json: { runsPerCase: RUNS, totalPass, totalTool, totalRuns, rows }, markdown };
}

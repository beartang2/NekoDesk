import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import type { ParsedAgentStep } from "../src/agent/types";
import { CASES } from "./cases";
import { noPythonSyntax, scoreStep } from "./scoring";

/**
 * 채점기 자체를 검증한다. 채점이 틀리면 평가 점수가 아무 의미가 없다.
 * 특히 "지식 문서에 적힌 정답 예시"가 만점을 받는지 확인해서 체크가 과하게
 * 엄격하지 않은지 막는다.
 */

function step(tool: string, params: Record<string, unknown> = {}, finalAnswer?: string): ParsedAgentStep {
  return { thought: "", tool, params, finalAnswer };
}

function caseById(id: string) {
  const c = CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  return c;
}

/** music.md 에서 첫 applescript 코드 블록 중 조건에 맞는 것을 꺼낸다. */
function knowledgeExample(containing: string): string {
  const md = readFileSync(join(__dirname, "../src/agent/knowledge/applescript/music.md"), "utf8");
  const blocks = [...md.matchAll(/```applescript\n([\s\S]*?)```/g)].map((m) => m[1]);
  const found = blocks.find((b) => b.includes(containing));
  if (!found) throw new Error(`no example containing ${containing}`);
  return found;
}

describe("케이스 정의", () => {
  it("id 가 겹치지 않는다", () => {
    const ids = CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("모든 케이스에 허용 도구가 하나 이상 있다", () => {
    for (const c of CASES) expect(c.accept.length, c.id).toBeGreaterThan(0);
  });
});

describe("지식 문서의 정답 예시는 만점이다", () => {
  it("네코 플레이리스트 예시", () => {
    const code = knowledgeExample("Neko's Playlist");
    const score = scoreStep(step("code.exec", { code, language: "applescript" }), caseById("music-playlist-mood"));
    expect(score.checks.filter((c) => !c.ok)).toEqual([]);
    expect(score.pass).toBe(true);
  });

  it("추천 후 재생 예시", () => {
    const code = knowledgeExample("set candidates to");
    const score = scoreStep(step("code.exec", { code, language: "applescript" }), caseById("music-play-generic"));
    expect(score.pass).toBe(true);
  });
});

describe("흔한 오답을 잡는다", () => {
  it("엉뚱한 도구를 고르면 실패", () => {
    const score = scoreStep(step("web.search", { query: "playlist" }), caseById("music-playlist-mood"));
    expect(score.toolOk).toBe(false);
    expect(score.pass).toBe(false);
  });

  it("새 플레이리스트를 다른 이름으로 만들면 실패", () => {
    const code = `tell application "Music"
    make new playlist with properties {name:"비 오는 날"}
    duplicate (item 1 of (search library playlist "Library" for "rain")) to playlist "Neko's Playlist"
end tell`;
    const score = scoreStep(step("code.exec", { code, language: "applescript" }), caseById("music-playlist-mood"));
    expect(score.pass).toBe(false);
  });

  it("존재하지 않는 add ... to playlist 문법이면 실패", () => {
    const code = `tell application "Music"
    add theTrack to playlist "Neko's Playlist"
end tell`;
    const score = scoreStep(step("code.exec", { code, language: "applescript" }), caseById("music-playlist-add"));
    expect(score.pass).toBe(false);
  });

  it("AppleScript 에 파이썬 문법이 섞이면 잡는다", () => {
    for (const bad of ['queries = ["a", "b"]', "for q in queries:", 'set x to ["a", "b"]']) {
      expect(noPythonSyntax.test(step("code.exec", { code: bad })), bad).toBe(false);
    }
    expect(noPythonSyntax.test(step("code.exec", { code: 'set queries to {"a", "b"}\nif x = 1 then' }))).toBe(true);
  });

  it("뉴스를 기억으로 답하면(도구 없음) 실패", () => {
    const score = scoreStep(step("none", {}, "오늘 보안 뉴스는..."), caseById("news-security-today"));
    expect(score.pass).toBe(false);
  });

  it("스키마에 안 맞는 파라미터면 실패", () => {
    const score = scoreStep(step("schedule.add", { title: "팀 회의" }), caseById("schedule-add-tomorrow"));
    expect(score.checks.find((c) => c.name === "파라미터 스키마")?.ok).toBe(false);
    expect(score.pass).toBe(false);
  });
});

describe("참고용 체크는 통과 판정에 영향이 없다", () => {
  it("한국어 검색어여도 주제가 맞으면 통과", () => {
    const score = scoreStep(step("web.search", { query: "오늘 보안 뉴스" }), caseById("news-security-today"));
    expect(score.pass).toBe(true);
    expect(score.checks.find((c) => !c.critical)?.ok).toBe(false);
  });
});

describe("날짜는 앱과 같은 방식으로 정규화해서 비교한다", () => {
  it("모델이 한국어 표현을 그대로 넘겨도 앱이 맞게 바꾸면 통과", () => {
    const score = scoreStep(
      step("schedule.add", { title: "팀 회의", start_at: "내일 오후 3시" }),
      caseById("schedule-add-tomorrow")
    );
    expect(score.pass).toBe(true);
  });

  it("시각이 틀리면 실패", () => {
    const score = scoreStep(
      step("schedule.add", { title: "팀 회의", start_at: "내일 오전 3시" }),
      caseById("schedule-add-tomorrow")
    );
    expect(score.pass).toBe(false);
  });
});

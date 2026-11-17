import type { NekoActivity } from "../engine/neko-engine";
import type { ToolCue } from "./types";

/**
 * 도구 → 활동(설계 docs/neko-p2-director.md §4). 도구가 하는 일을 고양이가 '흉내' 낸다.
 * P3 에서 달력 보기·지우기·상자 뒤지기·골똘히를 더했다.
 */

/** 엔진이 스스로 끝내는 활동 */
export const ONE_SHOT: ReadonlySet<NekoActivity> = new Set(["stamp", "snack", "stretch", "climb", "erase"]);

/** 결과 판정에서 '무언가를 바꾼' 도구(떨기) */
export const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "todo.add", "todo.complete", "schedule.add", "schedule.delete", "code.exec", "file.upload",
]);

const TABLE: Record<string, NekoActivity> = {
  "todo.list": "reading",
  "todo.list_done": "reading",
  "todo.add": "typing",
  "todo.complete": "stamp",
  "schedule.list": "calendar",
  "schedule.add": "stamp",
  "schedule.delete": "erase",
  "code.exec": "typing",
  "web.search": "window",
  "web.scrape": "reading",
  "weather.get": "window",
  "game.start": "draw", // 끝말잇기는 아래에서 타이핑으로
  file: "dig",
  "file.upload": "dig",
  clipboard: "knead",
  "math.eval": "draw",
};

const MUSIC_APP = /\b(Music|Spotify|iTunes)\b/;

/** AppleScript 로 음악 앱을 다루는 코드인가 */
export function isMusicScript(params: Record<string, unknown> | undefined): boolean {
  const code = typeof params?.code === "string" ? params.code : "";
  const lang = typeof params?.language === "string" ? params.language.toLowerCase() : "";
  const apple = lang === "applescript" || lang === "osascript" || /\bosascript\b|tell application/i.test(code);
  return apple && MUSIC_APP.test(code);
}

/** 도구 이름(+필요하면 인자)으로 활동을 고른다. MCP·모르는 도구는 타이핑 */
export function toolCue(name: string, params?: Record<string, unknown>): ToolCue {
  let activity: NekoActivity = TABLE[name] ?? "typing";
  if (name === "code.exec" && isMusicScript(params)) activity = "music";
  if (name === "game.start" && params?.type === "wordchain") activity = "think";
  return { name, activity, oneShot: ONE_SHOT.has(activity), writes: WRITE_TOOLS.has(name) };
}

/** 표에 직접 적힌 도구(테스트: 등록된 도구가 모두 들어 있는지) */
export const MAPPED_TOOLS: readonly string[] = Object.keys(TABLE);

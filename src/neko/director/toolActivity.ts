import { getTool, isStaticTool } from "../../agent/tool-registry";
import type { ToolName } from "../../agent/types";
import type { NekoActivity } from "../engine/neko-engine";
import type { ToolCue } from "./types";

/**
 * 도구 → 활동(설계 docs/neko-p2-director.md §4). 도구가 하는 일을 고양이가 '흉내' 낸다.
 * 지금 있는 활동 14개로 맞췄다. P3 에서 새 활동(달력 보기·상자 뒤지기·골똘히)이 생기면 이 표만 바꾼다.
 */

/** 엔진이 스스로 끝내는 활동 */
export const ONE_SHOT: ReadonlySet<NekoActivity> = new Set(["stamp", "snack", "stretch", "climb"]);

/** 결과 판정에서 '무언가를 바꾼' 도구(떨기). registry 의 readOnly 로 본다(MCP 는 모르니 아니라고 본다) */
export function writesSomething(name: string): boolean {
  return isStaticTool(name) && !getTool(name).readOnly;
}

/** 빠진 도구는 타입 검사가 잡는다(user.ask 는 기다림이라 뺀다) */
const TABLE: Record<Exclude<ToolName, "user.ask">, NekoActivity> = {
  "todo.list": "reading",
  "todo.list_done": "reading",
  "todo.add": "typing",
  "todo.complete": "stamp",
  "schedule.list": "reading", // P3: 달력 보기
  "schedule.add": "stamp",
  "schedule.delete": "stamp", // P3: 지우기 변형
  "code.exec": "typing",
  "web.search": "window",
  "web.scrape": "reading",
  "weather.get": "window",
  "game.start": "draw", // 끝말잇기는 아래에서 타이핑으로
  "game.judge": "typing", // P3: 골똘히
  "file.upload": "box", // P3: 상자 뒤지기
  "image.generate": "draw",
  "image.trace": "draw",
  "fs.read": "reading",
  "fs.write": "typing",
  "fs.edit": "typing",
  "fs.list": "box", // P3: 상자 뒤지기
  "fs.glob": "box",
  "fs.grep": "box",
  "skill.read": "reading",
  "plan.set": "typing",
  "plan.complete": "stamp", // 할 일 완료처럼 칸에 꾹
  "memory.save": "knead",
  "memory.search": "typing", // P3: 골똘히
  "security.check": "window",
  "process.list": "reading",
  "agent.delegate": "window", // 조사를 맡겼다: 바깥을 살핀다
  "airdrop.send": "box",
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
  let activity: NekoActivity = TABLE[name as keyof typeof TABLE] ?? "typing";
  if (name === "code.exec" && isMusicScript(params)) activity = "music";
  if (name === "game.start" && params?.type === "wordchain") activity = "typing"; // P3: 골똘히
  return { name, activity, oneShot: ONE_SHOT.has(activity), writes: writesSomething(name) };
}

/** 표에 직접 적힌 도구(테스트: 등록된 도구가 모두 들어 있는지) */
export const MAPPED_TOOLS: readonly string[] = Object.keys(TABLE);

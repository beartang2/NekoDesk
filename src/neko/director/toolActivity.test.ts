// @vitest-environment jsdom
// 도구 표가 tool-registry(→ settingsStore 가 localStorage 를 읽는다)를 불러온다

import { describe, expect, it } from "vitest";
import { getAllTools } from "../../agent/tool-registry";
import { isMusicScript, MAPPED_TOOLS, toolCue } from "./toolActivity";

describe("도구 → 활동", () => {
  it("등록된 도구는 모두 표에 있다(새 도구를 넣고 표를 잊지 않게)", () => {
    const missing = getAllTools().map((t) => t.name as string).filter((n) => n !== "user.ask" && !MAPPED_TOOLS.includes(n));
    expect(missing).toEqual([]);
  });

  it("도구가 하는 일을 흉내 낸다", () => {
    expect(toolCue("web.search").activity).toBe("window");
    expect(toolCue("weather.get").activity).toBe("window");
    expect(toolCue("web.scrape").activity).toBe("reading");
    expect(toolCue("todo.list").activity).toBe("reading");
    expect(toolCue("file.upload").activity).toBe("box");
    expect(toolCue("fs.read").activity).toBe("reading");
    expect(toolCue("memory.save").activity).toBe("knead");
    expect(toolCue("image.generate").activity).toBe("draw");
  });

  it("발도장은 한 번짜리, 쓰기 도구 표시", () => {
    const c = toolCue("todo.complete");
    expect(c).toMatchObject({ activity: "stamp", oneShot: true, writes: true });
    expect(toolCue("todo.list")).toMatchObject({ oneShot: false, writes: false });
    expect(toolCue("schedule.delete").writes).toBe(true);
    expect(toolCue("fs.write").writes).toBe(true);
  });

  it("MCP·모르는 도구는 타이핑", () => {
    expect(toolCue("mcp__github__list_issues")).toMatchObject({ activity: "typing", oneShot: false, writes: false });
  });

  it("음악 앱을 다루는 AppleScript 는 음악 듣기", () => {
    const code = 'tell application "Spotify" to play';
    expect(isMusicScript({ language: "applescript", code })).toBe(true);
    expect(toolCue("code.exec", { language: "applescript", code }).activity).toBe("music");
    expect(toolCue("code.exec", { language: "bash", code: `osascript -e 'tell application "Music" to pause'` }).activity).toBe("music");
    expect(toolCue("code.exec", { language: "python", code: "print('Music')" }).activity).toBe("typing");
    expect(toolCue("code.exec", { language: "applescript", code: 'display notification "hi"' }).activity).toBe("typing");
  });

  it("끝말잇기 시작은 타이핑, 그림 맞히기는 그림", () => {
    expect(toolCue("game.start", { type: "wordchain" }).activity).toBe("typing");
    expect(toolCue("game.start", { type: "drawing" }).activity).toBe("draw");
  });
});

// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

/** 폰의 code.exec: Python 만, 격리된 곳(lib/pyBox)에서. 승인은 맥과 같은 길이고 그리는 법(skill.read)도 같이 있다 */
const h = vi.hoisted(() => ({ run: vi.fn(), invoke: vi.fn(async () => null) }));
vi.mock("../lib/platform", () => ({ IS_PHONE: true, IS_MAC: false }));
vi.mock("../lib/pyBox", () => ({ runPython: h.run }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import { getAllTools, getTool } from "./tool-registry";
import { buildSkillIndex, readKnowledge } from "./knowledge";
import { isClaudeActive, useSettingsStore } from "../stores/settingsStore";
import { claudeUrl } from "../lib/claude-models";

beforeEach(() => { h.run.mockReset(); h.invoke.mockClear(); });

describe("폰의 코드 실행", () => {
  it("스키마는 Python 만(셸·AppleScript·작업 폴더 없음), 그리는 법 읽기 도구가 같이 있다", () => {
    const names = getAllTools().map((t) => t.name);
    expect(names).toContain("code.exec");
    expect(names).toContain("skill.read");
    const tool = getTool("code.exec");
    const props = tool.params.properties as Record<string, { enum?: string[] }>;
    expect(props.language.enum).toEqual(["python"]);
    expect(Object.keys(props).sort()).toEqual(["code", "language"]);
    expect(tool.description).not.toMatch(/Shell|AppleScript|nekodesk/);
    // 그리는 법 목록엔 AppleScript 가 없다. 그림 문서는 맥과 같은 것
    expect(buildSkillIndex()).toBe("- 그림그리기: SVG 로 그림·아이콘·캐릭터 그리기");
    expect(readKnowledge("그림그리기")?.content).toContain("SVG");
    // 큰 모델용 본문(폰은 늘 Claude): 맥과 같은 그림 도구를 쓰고, 폰에 없는 fs.read 는 가리키지 않는다
    useSettingsStore.setState({ llmUrl: claudeUrl("claude-test") });
    expect(isClaudeActive()).toBe(true);
    const pro = readKnowledge("그림그리기")!.content;
    expect(pro).toContain("from neko_draw import *");
    expect(pro).not.toContain("fs.read");
  });

  it("승인 없이는 안 돌고, Python 이 아니면 거절하고, Python 은 격리된 실행기로 간다(백엔드 code_exec 를 부르지 않는다)", async () => {
    const tool = getTool("code.exec");
    await expect(tool.execute({ code: "print(1)", language: "python" })).rejects.toThrow("승인");
    expect(await tool.execute({ code: "ls", language: "shell", __approved: true })).toMatchObject({ exit_code: 1, stderr: expect.stringContaining("Python 만") });
    expect(await tool.execute({ code: "tell app", language: "applescript", __approved: true })).toMatchObject({ exit_code: 1 });
    expect(h.run).not.toHaveBeenCalled();
    h.run.mockResolvedValue({ stdout: "저장: cat.svg", stderr: "", exit_code: 0, truncated: false, image_data_url: "data:image/svg+xml;base64,AAAA" });
    const r = await tool.execute({ code: "from neko_draw import *", language: "python", __approved: true });
    expect(h.run).toHaveBeenCalledWith("from neko_draw import *");
    expect(r).toMatchObject({ exit_code: 0, image_data_url: "data:image/svg+xml;base64,AAAA" });
    expect(tool.summarize(r)).toContain("저장: cat.svg");
    expect(h.invoke.mock.calls.some((c) => (c as unknown[])[0] === "code_exec")).toBe(false);
  });
});

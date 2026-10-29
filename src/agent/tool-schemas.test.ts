// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { buildToolSchemas, describeToolsForPrompt } from "./tool-schemas";
import { clipList, getAllTools } from "./tool-registry";
import { DEFAULT_IMAGE_GEN, setServerToolCaps, useSettingsStore } from "../stores/settingsStore";

describe("buildToolSchemas", () => {
  it("이미지 생성을 꺼두면 image.generate 를 싣지 않는다", () => {
    const names = () => buildToolSchemas().map((s) => s.function.name);
    useSettingsStore.getState().setImageGen({ ...DEFAULT_IMAGE_GEN, provider: "off" });
    expect(names()).not.toContain("image.generate");
    useSettingsStore.getState().setImageGen({ ...DEFAULT_IMAGE_GEN, provider: "cloudflare" });
    expect(names()).toContain("image.generate");
  });

  it("모델에 같은 일을 하는 서버 툴이 있으면 겹치는 로컬 툴은 자동으로 빠지고, 없으면 돌아온다", () => {
    const names = () => buildToolSchemas().map((s) => s.function.name);
    useSettingsStore.getState().setLlmUrl("claude://claude-haiku-5-5");
    // 능력을 아직 모르면(앱 켠 직후) 로컬 툴 그대로.
    expect(names()).toEqual(expect.arrayContaining(["web.search", "web.scrape"]));
    setServerToolCaps("claude-haiku-5-5", { web_search: true, web_fetch: false });
    expect(names()).not.toContain("web.search");
    expect(names()).toContain("web.scrape");
    setServerToolCaps("claude-haiku-5-5", { web_search: true, web_fetch: true });
    expect(names()).not.toContain("web.scrape");
    // 로컬 모델로 돌아오면 다시 로컬 툴.
    useSettingsStore.getState().setLlmUrl("http://127.0.0.1:8803");
    expect(names()).toEqual(expect.arrayContaining(["web.search", "web.scrape"]));
    setServerToolCaps("claude-haiku-5-5", { web_search: false, web_fetch: false });
  });

  it("registry 의 모든 툴을 빠짐없이 내보낸다", () => {
    const names = buildToolSchemas().map((s) => s.function.name);
    for (const tool of getAllTools()) {
      expect(names).toContain(tool.name);
    }
  });

  it("OpenAI tools 배열 형태를 지킨다", () => {
    for (const schema of buildToolSchemas()) {
      expect(schema.type).toBe("function");
      expect(schema.function.name).toBeTruthy();
      expect(schema.function.description).toBeTruthy();
      expect(schema.function.parameters.type).toBe("object");
      expect(typeof schema.function.parameters.properties).toBe("object");
    }
  });

  it("required 는 실제 존재하는 프로퍼티만 가리킨다", () => {
    for (const { function: fn } of buildToolSchemas()) {
      for (const key of fn.parameters.required ?? []) {
        expect(Object.keys(fn.parameters.properties)).toContain(key);
      }
    }
  });

  it("schedule.list 의 range 는 enum 으로 제한된다", () => {
    const schema = buildToolSchemas().find((s) => s.function.name === "schedule.list");
    expect(schema?.function.parameters.properties["range"].enum).toEqual([
      "today",
      "week",
      "all",
    ]);
  });
});

describe("describeToolsForPrompt", () => {
  it("json 폴백 프롬프트를 같은 registry 에서 만든다", () => {
    const text = describeToolsForPrompt();
    for (const tool of getAllTools()) {
      expect(text).toContain(`- ${tool.name}:`);
    }
  });

  it("필수 파라미터를 표시한다", () => {
    const line = describeToolsForPrompt()
      .split("\n")
      .find((l) => l.startsWith("- todo.add:"));
    expect(line).toContain('"content": string (필수)');
    expect(line).toContain('"due_at": string');
    expect(line).not.toContain('"due_at": string (필수)');
  });

  it("enum 은 값 목록으로 펼친다", () => {
    const line = describeToolsForPrompt()
      .split("\n")
      .find((l) => l.startsWith("- schedule.list:"));
    expect(line).toContain('"range": "today" | "week" | "all" (필수)');
  });
});

describe("clipList", () => {
  it("잘라낸 개수를 적는다 — 말없이 자르면 모델은 뒤가 없는 줄 안다", () => {
    const out = clipList([1, 2, 3], 2, (n) => `- ${n}`);
    expect(out).toBe("- 1\n- 2\n…외 1개 더 있음");
    expect(clipList([1], 2, (n) => `- ${n}`)).toBe("- 1");
  });
});

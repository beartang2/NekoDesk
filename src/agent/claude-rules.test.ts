// @vitest-environment jsdom

import { afterEach, expect, it } from "vitest";
import { __promptsForTest } from "./llm-client";
import { useSettingsStore } from "../stores/settingsStore";
import { claudeUrl } from "../lib/claude-models";

const local = useSettingsStore.getState().llmUrl;
afterEach(() => useSettingsStore.setState({ llmUrl: local }));

it("Claude 는 말의 겉모양별 규칙 대신 원칙만 받는다 — 프롬프트도 짧아진다", () => {
  const small = __promptsForTest.system(true);
  useSettingsStore.setState({ llmUrl: claudeUrl("claude-haiku-5-5") });
  const claude = __promptsForTest.system(true);

  expect(small).toContain('"너가", "네가", "추천해줘"');
  expect(claude).not.toContain('"너가", "네가", "추천해줘"');
  expect(claude).toContain("web.search");
  expect(claude).toContain("game.start");
  // 말투 규칙은 그대로 — 고양이 말투는 모델과 상관없다.
  expect(claude).toContain("반말(해체)");
  expect(claude.length).toBeLessThan(small.length);
});

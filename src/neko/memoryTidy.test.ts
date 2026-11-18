// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock("../api/tauri", () => ({
  settingsApi: { get: async (k: string) => settings.get(k) ?? null, set: async (k: string, v: string) => void settings.set(k, v) },
}));
vi.mock("../agent/memory-tidy", () => ({ tidyMemories: async () => null }));
vi.mock("../stores/claudeBudget", () => ({ budgetBlockReason: () => null }));

import { tidyBlock } from "./memoryTidy";
import { useNekoApp } from "./director/stores";
import { useSettingsStore } from "../stores/settingsStore";

beforeEach(() => {
  settings.clear();
  useSettingsStore.setState({ memoryTidy: true, llmUrl: "claude://claude-sonnet-5-5" });
  useNekoApp.setState({ feeding: null });
});

describe("쉴 때 기억 정리의 때", () => {
  it("Claude·켬·밥 안 먹음·오늘 처음·산책 아님일 때만", async () => {
    expect(await tidyBlock()).toBeNull();
    useSettingsStore.setState({ memoryTidy: false });
    expect(await tidyBlock()).toBe("꺼 둠");
    useSettingsStore.setState({ memoryTidy: true, llmUrl: "http://localhost:8080" });
    expect(await tidyBlock()).toBe("Claude 프로필이 아님");
    useSettingsStore.setState({ llmUrl: "claude://claude-sonnet-5-5" });

    settings.set("neko_walk", JSON.stringify({ path: [[0, 0, Date.now() - 1000], [0, 0, Date.now() + 60_000]] }));
    expect(await tidyBlock()).toBe("산책 중");
    settings.set("neko_walk", JSON.stringify({ path: [[0, 0, 0], [0, 0, 1]] }));
    expect(await tidyBlock()).toBe("산책 보고를 기다리는 중");
    settings.set("neko_walk", JSON.stringify({ path: [[0, 0, 0], [0, 0, 1]], done: true }));
    expect(await tidyBlock()).toBeNull();

    settings.set("neko_memory_tidy_day", new Date().toDateString());
    expect(await tidyBlock()).toBe("오늘 이미 함");
  });

  it("정리하며 먹는 밥은 네코를 깨우지 않는다", () => {
    useNekoApp.setState({ lastActiveAt: 5 });
    useNekoApp.getState().setFeeding(true, false);
    expect(useNekoApp.getState().feeding).not.toBeNull();
    expect(useNekoApp.getState().lastActiveAt).toBe(5);
    useNekoApp.getState().setFeeding(false);
  });
});

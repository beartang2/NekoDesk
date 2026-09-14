// @vitest-environment jsdom

import { it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { ModelProfilesSection } from "./SettingsModal";
import { useSettingsStore } from "../stores/settingsStore";

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  invoke.mockResolvedValue([]);
  // 어떤 서버도 안 떠 있는 상태
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
});

/** 목록에서 한 번 누르면 그 프로필로 연결된다 — 이 기능의 전부. */
it("프로필 행을 누르면 활성 주소가 바뀌고 관리형이면 서버를 띄운다", async () => {
  localStorage.setItem("nekodesk_model_profiles", JSON.stringify({
    activeId: "ext",
    profiles: [
      { id: "ext", name: "외부", url: "http://192.168.0.10:8080", config: null },
      { id: "loc", name: "로컬 큐원", url: "", config: { model: "qwen3-8b.gguf", port: 8803, host: "127.0.0.1" } },
    ],
  }));

  render(<ModelProfilesSection />);
  fireEvent.click(screen.getByText("로컬 큐원"));

  await waitFor(() => expect(useSettingsStore.getState().llmUrl).toBe("http://127.0.0.1:8803"));
  expect(invoke).toHaveBeenCalledWith("llama_start", expect.anything());
});

// @vitest-environment jsdom

import { it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const invoke = vi.hoisted(() => vi.fn());
const keyState = vi.hoisted(() => ({ has: false }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

import { ModelSwitcher } from "./ModelSwitcher";
import { ModelProfilesSection } from "./SettingsModal";
import { useSettingsStore } from "../stores/settingsStore";

afterEach(() => cleanup());

// Radix 의 위치 계산이 쓰는데 jsdom 엔 없다.
class RO { observe() {} unobserve() {} disconnect() {} }

beforeEach(() => {
  localStorage.clear();
  keyState.has = false;
  vi.stubGlobal("ResizeObserver", RO);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "secret_has") return keyState.has;
    if (cmd === "llama_scan_models") return [];
    return undefined;
  });
  localStorage.setItem("nekodesk_model_profiles", JSON.stringify({
    activeId: "ext",
    profiles: [
      { id: "ext", name: "맥미니 큐원", url: "http://192.168.0.10:8080", config: null },
      { id: "cl", name: "Claude Haiku 5.5", url: "claude://claude-haiku-5-5", config: null },
    ],
  }));
  useSettingsStore.getState().setLlmUrl("http://192.168.0.10:8080");
});

it("제목 표시줄 칩에서 Claude 를 고르면 그쪽으로 묻는다", async () => {
  keyState.has = true;
  render(<ModelSwitcher onManage={() => {}} />);
  fireEvent.click(screen.getByTitle("모델 바꾸기"));
  fireEvent.click(await screen.findByText("Claude Haiku 5.5", { selector: ".model-pop__name" }));

  await waitFor(() => expect(useSettingsStore.getState().llmUrl).toBe("claude://claude-haiku-5-5"));
  expect(JSON.parse(localStorage.getItem("nekodesk_model_profiles")!).activeId).toBe("cl");
});

it("키가 없으면 고른 자리에서 바로 알려준다", async () => {
  render(<ModelSwitcher onManage={() => {}} />);
  fireEvent.click(screen.getByTitle("모델 바꾸기"));
  fireEvent.click(await screen.findByText("Claude Haiku 5.5", { selector: ".model-pop__name" }));
  expect(await screen.findByText(/API 키가 없어/)).toBeTruthy();
});

it("모델 관리는 설정으로 넘긴다", async () => {
  const onManage = vi.fn();
  render(<ModelSwitcher onManage={onManage} />);
  fireEvent.click(screen.getByTitle("모델 바꾸기"));
  fireEvent.click(await screen.findByText("모델 관리"));
  expect(onManage).toHaveBeenCalled();
});

it("설정에서 Claude 프로필을 추가하면 모델·키·예산 칸이 열린다", async () => {
  render(<ModelProfilesSection />);
  fireEvent.click(screen.getByRole("button", { name: "Claude" }));
  expect(await screen.findByPlaceholderText("sk-ant-…")).toBeTruthy();
  expect(screen.getByText("월 예산 (USD)")).toBeTruthy();

  // 모델을 Sonnet 으로 바꾸면 기본 이름도 따라 바뀐다.
  fireEvent.click(screen.getByRole("radio", { name: "Sonnet 5.5" }));
  await waitFor(() => {
    const saved = JSON.parse(localStorage.getItem("nekodesk_model_profiles")!);
    const added = saved.profiles[saved.profiles.length - 1];
    expect(added.url).toBe("claude://claude-sonnet-5-5");
    expect(added.name).toBe("Claude Sonnet 5.5");
  });
});

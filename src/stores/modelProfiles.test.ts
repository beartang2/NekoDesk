// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  DEFAULT_LLAMA_CONFIG,
  activateProfile,
  loadProfiles,
  profileUrl,
  type ModelProfile,
} from "./modelProfiles";
import { useSettingsStore } from "./settingsStore";

function localProfile(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: "a",
    name: "로컬",
    url: "",
    config: { ...DEFAULT_LLAMA_CONFIG, model: "/Users/me/models/qwen3-8b.gguf" },
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  vi.restoreAllMocks();
});

describe("profileUrl", () => {
  it("관리형은 실행 설정에서 주소를 뽑는다", () => {
    expect(profileUrl(localProfile())).toBe("http://127.0.0.1:8803");
  });

  it("0.0.0.0 에 띄운 서버라도 앱은 루프백으로 붙는다", () => {
    const p = localProfile();
    p.config!.host = "0.0.0.0";
    expect(profileUrl(p)).toBe("http://127.0.0.1:8803");
  });
});

describe("마이그레이션", () => {
  it("쓰던 로컬 설정이 그대로 기본 프로필이 된다", () => {
    localStorage.setItem("nekodesk_llama_config", JSON.stringify({ model: "qwen3-8b.gguf", port: 8803 }));
    localStorage.setItem("nekodesk_llm_url", "http://127.0.0.1:8803");

    const { profiles, activeId } = loadProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].name).toBe("qwen3-8b");
    expect(profiles[0].config?.model).toBe("qwen3-8b.gguf");
    expect(activeId).toBe(profiles[0].id);
  });

  it("보고 있던 주소가 로컬 서버와 다르면 외부 프로필로 함께 남고, 그쪽이 활성이다", () => {
    localStorage.setItem("nekodesk_llama_config", JSON.stringify({ model: "qwen3-8b.gguf" }));
    localStorage.setItem("nekodesk_llm_url", "http://192.168.0.10:8080");

    const { profiles, activeId } = loadProfiles();
    expect(profiles).toHaveLength(2);
    const active = profiles.find((p) => p.id === activeId)!;
    expect(active.config).toBeNull();
    expect(active.url).toBe("http://192.168.0.10:8080");
  });

  it("앱으로 서버를 띄운 적 없으면 손으로 띄워둔 주소만 프로필이 된다", () => {
    localStorage.setItem("nekodesk_llm_url", "http://127.0.0.1:1234");
    const { profiles } = loadProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].config).toBeNull();
  });
});

describe("activateProfile", () => {
  it("외부 프로필은 주소만 바꾸고 서버를 띄우지 않는다", async () => {
    await activateProfile({ id: "x", name: "외부", url: "http://192.168.0.10:8080", config: null });
    expect(useSettingsStore.getState().llmUrl).toBe("http://192.168.0.10:8080");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("같은 모델이 이미 떠 있으면 다시 띄우지 않는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "/Users/me/models/qwen3-8b.gguf" }] }),
    }));
    await activateProfile(localProfile());
    expect(invoke).not.toHaveBeenCalled();
  });

  it("같은 포트에 다른 모델이 떠 있으면 갈아탄다", async () => {
    // 프로필 두 개가 같은 포트를 쓰는 흔한 경우. 생사만 봤다면 이전 모델에 그대로 붙는다.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "/Users/me/models/gemma-3-4b.gguf" }] }),
    }));
    await activateProfile(localProfile());
    expect(invoke).toHaveBeenCalledWith("llama_start", expect.anything());
  });

  it("서버가 없으면 띄운다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await activateProfile(localProfile());
    expect(invoke).toHaveBeenCalledWith("llama_start", expect.anything());
  });
});

// @vitest-environment jsdom

import { describe, it, expect, beforeEach, vi } from "vitest";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import {
  DEFAULT_LLAMA_CONFIG,
  activateProfile,
  isClaudeProfile,
  loadProfiles,
  profileUrl,
  saveProfiles,
  switchToClaudeIfReady,
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
  invoke.mockResolvedValue(undefined);
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
    // 로컬이 활성이고, Claude 는 목록에만 들어 있다(키가 아직 없다).
    expect(profiles.map((p) => isClaudeProfile(p))).toEqual([false, true]);
    expect(profiles[0].name).toBe("qwen3-8b");
    expect(profiles[0].config?.model).toBe("qwen3-8b.gguf");
    expect(activeId).toBe(profiles[0].id);
  });

  it("보고 있던 주소가 로컬 서버와 다르면 외부 프로필로 함께 남고, 그쪽이 활성이다", () => {
    localStorage.setItem("nekodesk_llama_config", JSON.stringify({ model: "qwen3-8b.gguf" }));
    localStorage.setItem("nekodesk_llm_url", "http://192.168.0.10:8080");

    const { profiles, activeId } = loadProfiles();
    expect(profiles.filter((p) => !isClaudeProfile(p))).toHaveLength(2);
    const active = profiles.find((p) => p.id === activeId)!;
    expect(active.config).toBeNull();
    expect(active.url).toBe("http://192.168.0.10:8080");
  });

  it("앱으로 서버를 띄운 적 없으면 손으로 띄워둔 주소가 프로필이 된다", () => {
    localStorage.setItem("nekodesk_llm_url", "http://127.0.0.1:1234");
    const { profiles, activeId } = loadProfiles();
    const locals = profiles.filter((p) => !isClaudeProfile(p));
    expect(locals).toHaveLength(1);
    expect(locals[0].config).toBeNull();
    expect(activeId).toBe(locals[0].id);
  });

  it("처음 설치면 Claude 가 활성이고 로컬 서버 프로필이 같이 있다", () => {
    const { profiles, activeId } = loadProfiles();
    const active = profiles.find((p) => p.id === activeId)!;
    expect(isClaudeProfile(active)).toBe(true);
    expect(active.url).toBe("claude://claude-haiku-5-5");
    expect(profiles.some((p) => !isClaudeProfile(p) && p.url === "http://127.0.0.1:8803")).toBe(true);
    expect(useSettingsStore.getState().llmUrl).toBe("claude://claude-haiku-5-5");
  });

  it("이미 저장된 목록엔 Claude 를 한 번만 끼워 넣고, 지우면 되살리지 않는다", () => {
    localStorage.setItem("nekodesk_model_profiles", JSON.stringify({
      activeId: "ext",
      profiles: [{ id: "ext", name: "외부", url: "http://192.168.0.10:8080", config: null }],
    }));
    const first = loadProfiles();
    expect(first.profiles.some(isClaudeProfile)).toBe(true);
    expect(first.activeId).toBe("ext"); // 활성은 그대로

    saveProfiles({ ...first, profiles: first.profiles.filter((p) => !isClaudeProfile(p)) });
    expect(loadProfiles().profiles.some(isClaudeProfile)).toBe(false);
  });
});

describe("switchToClaudeIfReady — 키가 있을 때만, 한 번만 Claude 를 기본으로", () => {
  function savedWithClaude() {
    localStorage.setItem("nekodesk_model_profiles", JSON.stringify({
      activeId: "ext",
      profiles: [
        { id: "ext", name: "외부", url: "http://192.168.0.10:8080", config: null },
        { id: "cl", name: "Claude", url: "claude://claude-haiku-5-5", config: null },
      ],
    }));
    return loadProfiles();
  }

  it("키가 없으면 건드리지 않고 다음 실행에 다시 본다", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "secret_has" ? false : undefined));
    expect(await switchToClaudeIfReady(savedWithClaude())).toBeNull();
    expect(loadProfiles().activeId).toBe("ext");
    expect(localStorage.getItem("nekodesk_claude_default_switched")).toBeNull();
  });

  it("키가 있으면 Claude 로 옮기고, 로컬 프로필은 목록에 남는다", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "secret_has" ? true : undefined));
    const switched = await switchToClaudeIfReady(savedWithClaude());
    expect(switched?.id).toBe("cl");
    const after = loadProfiles();
    expect(after.activeId).toBe("cl");
    expect(after.profiles.map((p) => p.id)).toEqual(["ext", "cl"]);
  });

  it("한 번 옮긴 뒤 사용자가 로컬로 되돌리면 다시 옮기지 않는다", async () => {
    invoke.mockImplementation(async (cmd: string) => (cmd === "secret_has" ? true : undefined));
    const state = savedWithClaude();
    await switchToClaudeIfReady(state);
    saveProfiles({ ...loadProfiles(), activeId: "ext" });
    expect(await switchToClaudeIfReady(loadProfiles())).toBeNull();
    expect(loadProfiles().activeId).toBe("ext");
  });
});

describe("activateProfile", () => {
  it("외부 프로필은 주소만 바꾸고 서버를 띄우지 않는다", async () => {
    await activateProfile({ id: "x", name: "외부", url: "http://192.168.0.10:8080", config: null });
    expect(useSettingsStore.getState().llmUrl).toBe("http://192.168.0.10:8080");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("같은 모델이 이미 떠 있으면 다시 띄우지 않고, 끌 때 내리도록 포트를 넘긴다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: "/Users/me/models/qwen3-8b.gguf" }] }),
    }));
    await activateProfile(localProfile());
    expect(invoke).not.toHaveBeenCalledWith("llama_start", expect.anything());
    expect(invoke).toHaveBeenCalledWith("llama_adopt", { port: 8803 });
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

  it("외부로 옮겨가면 앱이 띄웠던 서버를 내려놓는다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const ext: ModelProfile = { id: "x", name: "외부", url: "http://192.168.0.10:8080", config: null };
    await activateProfile(ext, localProfile());
    expect(invoke).toHaveBeenCalledWith("llama_stop", { port: 8803 });
    expect(invoke).not.toHaveBeenCalledWith("llama_start", expect.anything());
  });

  it("같은 포트의 로컬로 갈아탈 때는 llama_start 에 정리를 맡긴다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const other = localProfile({ id: "b", config: { ...DEFAULT_LLAMA_CONFIG, model: "gemma-3-4b.gguf" } });
    await activateProfile(other, localProfile());
    expect(invoke).not.toHaveBeenCalledWith("llama_stop", expect.anything());
    expect(invoke).toHaveBeenCalledWith("llama_start", expect.anything());
  });

  it("떠나온 게 외부 프로필이면 죽일 것도 없다", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const ext: ModelProfile = { id: "x", name: "외부", url: "http://192.168.0.10:8080", config: null };
    await activateProfile(localProfile(), ext);
    expect(invoke).not.toHaveBeenCalledWith("llama_stop", expect.anything());
  });
});

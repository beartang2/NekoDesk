// @vitest-environment jsdom

import { describe, it, expect, vi } from "vitest";

vi.mock("../api/tauri", () => ({
  conversationApi: { save: vi.fn(), load: vi.fn(), delete: vi.fn() },
}));
vi.mock("../agent/agent-loop", () => ({ runAgentLoop: vi.fn() }));
vi.mock("../lib/notify", () => ({ notifyIfAway: vi.fn(), toNotificationBody: (s: string) => s }));

import { parseMeta, serializeAttachments, serializeMeta } from "./useAgentLoop";
import type { AgentStep } from "../agent/types";
import type { AttachedFile } from "./useAgentLoop";

const image = (name: string, bytes: number): AttachedFile => ({
  name,
  content: "",
  dataUrl: "data:image/png;base64," + "A".repeat(bytes),
  size: bytes,
  type: "image/png",
});

describe("serializeAttachments", () => {
  it("첨부가 없으면 저장할 것도 없다", () => {
    expect(serializeAttachments([])).toBeUndefined();
  });

  it("이미지 데이터를 함께 저장한다 — 껐다 켜도 미리보기가 남게", () => {
    const parsed = JSON.parse(serializeAttachments([image("cat.png", 10)])!);
    expect(parsed[0]).toMatchObject({ name: "cat.png", type: "image/png" });
    expect(parsed[0].dataUrl).toContain("data:image/png");
  });

  it("텍스트 파일 본문은 빼고 저장한다 — 이미 메시지 본문에 들어가 있다", () => {
    const file: AttachedFile = { name: "a.ts", content: "const x = 1;", size: 12, type: "text/plain" };
    const parsed = JSON.parse(serializeAttachments([file])!);
    expect(parsed[0].content).toBe("");
    expect(parsed[0].name).toBe("a.ts");
  });

  it("너무 큰 이미지는 미리보기 없이 카드로만 남긴다", () => {
    const parsed = JSON.parse(serializeAttachments([image("huge.png", 3_000_000), image("small.png", 10)])!);
    expect(parsed[0].dataUrl).toBeUndefined();
    expect(parsed[0].name).toBe("huge.png");
    expect(parsed[1].dataUrl).toBeTruthy();
  });

  it("여러 장이 합쳐서 한도를 넘으면 앞의 것부터 담는다", () => {
    const parsed = JSON.parse(serializeAttachments([image("a.png", 1_500_000), image("b.png", 1_500_000)])!);
    expect(parsed[0].dataUrl).toBeTruthy();
    expect(parsed[1].dataUrl).toBeUndefined();
  });
});

describe("serializeMeta", () => {
  const step = (over: Partial<AgentStep> = {}): AgentStep => ({
    id: 1,
    thought: "찾아볼게",
    tool: "web.search",
    params: { query: "aula f87" },
    result: [{ title: "AULA", url: "https://x", snippet: "드라이버" }],
    summary: "- AULA (https://x): 드라이버",
    status: "done",
    ...over,
  });

  it("남길 게 없으면 저장하지 않는다", () => {
    expect(serializeMeta({ steps: [] })).toBeUndefined();
  });

  it("도구 기록이 다시 열어도 그대로 돌아온다", () => {
    const back = parseMeta(serializeMeta({ steps: [step()], tokensPerSecond: 24.5 }));
    expect(back.steps?.[0]).toMatchObject({ tool: "web.search", params: { query: "aula f87" }, status: "done" });
    expect(back.tokensPerSecond).toBe(24.5);
  });

  it("긴 결과는 잘라서 넣는다 — 긁은 웹 페이지를 통째로 담지 않는다", () => {
    const back = parseMeta(serializeMeta({ steps: [step({ result: "가".repeat(50_000) })] }));
    expect(String(back.steps?.[0].result).length).toBeLessThan(2100);
  });

  it("중단돼 실행 중으로 남은 스텝은 멈춘 것으로 저장한다 — 다시 열면 영원히 돈다", () => {
    const back = parseMeta(serializeMeta({ steps: [step({ status: "running" })] }));
    expect(back.steps?.[0]).toMatchObject({ status: "error", errorMessage: "중단됨" });
  });

  it("깨진 JSON 은 빈 값으로 읽는다", () => {
    expect(parseMeta("{broken")).toEqual({});
    expect(parseMeta(null)).toEqual({});
  });
});

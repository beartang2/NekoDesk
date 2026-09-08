import { describe, it, expect, vi, beforeEach } from "vitest";

const load = vi.fn();
vi.mock("../../api/tauri", () => ({ skillsApi: { load } }));

import { buildKnowledgeSection, reloadUserSkills } from "./index";

beforeEach(() => load.mockReset());

describe("사용자 스킬", () => {
  it("키워드가 걸리면 프롬프트에 붙는다", async () => {
    load.mockResolvedValue([
      { name: "배포 절차", keywords: ["배포", "deploy"], content: "1. 태그를 찍는다" },
    ]);
    expect(await reloadUserSkills()).toBe(1);

    const out = buildKnowledgeSection("배포 어떻게 하지");
    expect(out).toContain("배포 절차");
    expect(out).toContain("1. 태그를 찍는다");
  });

  it("안 걸리면 아무것도 안 붙는다", async () => {
    load.mockResolvedValue([{ name: "배포 절차", keywords: ["배포"], content: "내용" }]);
    await reloadUserSkills();
    expect(buildKnowledgeSection("오늘 날씨 어때")).toBe("");
  });

  it("내장 지식보다 앞에 온다 — 겹치면 사용자 것을 먼저 읽게", async () => {
    load.mockResolvedValue([
      { name: "내 볼륨 메모", keywords: ["볼륨"], content: "회사 맥은 30 이상 금지" },
    ]);
    await reloadUserSkills();

    const out = buildKnowledgeSection("볼륨 좀 줄여줘");
    expect(out).toContain("내 볼륨 메모");
    expect(out).toContain("AppleScript/시스템"); // 내장 것도 같이
    expect(out.indexOf("내 볼륨 메모")).toBeLessThan(out.indexOf("AppleScript/시스템"));
  });

  it("사용자 스킬이 없어도 내장 지식은 그대로 동작한다", async () => {
    load.mockResolvedValue([]);
    expect(await reloadUserSkills()).toBe(0);
    expect(buildKnowledgeSection("볼륨 줄여줘")).toContain("AppleScript/시스템");
  });
});

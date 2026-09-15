import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock 은 파일 맨 위로 끌어올려지므로 팩토리가 쓸 값은 vi.hoisted 로 만든다.
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
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

  it("배열이 아닌 게 와도 지식 조회가 죽지 않는다", async () => {
    // Tauri 커맨드가 예상 밖의 값을 주면 전개에서 터지고, 그 함수는 요청마다
    // 지나는 길이라 대화 전체가 멈춘다.
    load.mockResolvedValue(null as never);
    expect(await reloadUserSkills()).toBe(0);
    expect(() => buildKnowledgeSection("볼륨 줄여줘")).not.toThrow();
  });
});

describe("Claude 스킬 방식", () => {
  it('"/이름" 으로 부르면 키워드가 없어도 붙는다', async () => {
    load.mockResolvedValue([
      { name: "deploy", description: "배포 절차", keywords: [], content: "1. 태그" },
    ]);
    await reloadUserSkills();
    expect(buildKnowledgeSection("배포 어떻게 하지")).toBe("");
    const out = buildKnowledgeSection("/deploy 지금 해줘");
    expect(out).toContain("1. 태그");
    expect(out).toContain("/deploy 으로 직접 불렀어");
  });

  it("많이 걸린 지식이 앞에 온다", async () => {
    load.mockResolvedValue([
      { name: "하나", description: "", keywords: ["볼륨"], content: "a" },
      { name: "둘", description: "", keywords: ["볼륨", "밝기", "화면"], content: "b" },
    ]);
    await reloadUserSkills();
    const out = buildKnowledgeSection("볼륨이랑 화면 밝기 같이 조절해줘");
    expect(out.indexOf("### 둘")).toBeLessThan(out.indexOf("### 하나"));
  });

  it("예산이 차면 뒤쪽 지식은 버린다 — 첫 번째는 예외", async () => {
    const huge = "가".repeat(4000); // ≈ 4000 토큰, 예산(3000) 초과
    load.mockResolvedValue([
      { name: "큰것", description: "", keywords: ["배포"], content: huge },
      { name: "작은것", description: "", keywords: ["배포"], content: "작다" },
    ]);
    await reloadUserSkills();
    const out = buildKnowledgeSection("배포");
    expect(out).toContain("### 큰것");
    expect(out).not.toContain("### 작은것");
  });

  it("스킬 목록은 이름과 한 줄 요약만 싣는다", async () => {
    load.mockResolvedValue([
      { name: "deploy", description: "배포 절차", keywords: [], content: "본문은 목록에 안 실림" },
    ]);
    await reloadUserSkills();
    const { buildSkillIndex } = await import("./index");
    const index = buildSkillIndex();
    expect(index).toContain("- deploy: 배포 절차");
    expect(index).toContain("- AppleScript/Music:");
    expect(index).not.toContain("본문은 목록에");
  });
});

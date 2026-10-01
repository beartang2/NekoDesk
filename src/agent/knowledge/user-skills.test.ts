import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock 은 파일 맨 위로 끌어올려지므로 팩토리가 쓸 값은 vi.hoisted 로 만든다.
const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../../api/tauri", () => ({ skillsApi: { load } }));

import { buildKnowledgeSection, buildSkillIndex, readKnowledge, reloadUserSkills } from "./index";

beforeEach(() => load.mockReset());

describe("skill.read — 모델이 직접 읽는다", () => {
  it("이름으로 본문을 돌려준다", async () => {
    load.mockResolvedValue([{ name: "배포 절차", description: "배포", content: "1. 태그를 찍는다" }]);
    expect(await reloadUserSkills()).toBe(1);

    expect(readKnowledge("배포 절차")?.content).toBe("1. 태그를 찍는다");
    expect(readKnowledge("그림그리기")?.content).toContain("SVG");
  });

  it("대소문자·공백·선행 슬래시를 무시하고, 부분 이름도 받는다", async () => {
    load.mockResolvedValue([]);
    await reloadUserSkills();
    // 모델은 "/그림그리기", " 그림그리기 ", "Music" 처럼 제각각 적는다.
    expect(readKnowledge("/그림그리기")?.name).toBe("그림그리기");
    expect(readKnowledge("  그림그리기  ")?.name).toBe("그림그리기");
    expect(readKnowledge("music")?.name).toBe("AppleScript/Music");
  });

  it("없는 이름은 null — 툴이 목록을 되돌려줄 수 있게", async () => {
    load.mockResolvedValue([]);
    await reloadUserSkills();
    expect(readKnowledge("없는것")).toBeNull();
    expect(readKnowledge("")).toBeNull();
  });

  it("사용자 스킬이 내장보다 먼저 걸린다 — 이름이 겹치면 사용자 것", async () => {
    load.mockResolvedValue([{ name: "그림그리기", description: "내 방식", content: "회사 로고는 파란색" }]);
    await reloadUserSkills();
    expect(readKnowledge("그림그리기")?.content).toBe("회사 로고는 파란색");
  });
});

describe("키워드 자동 주입은 없다", () => {
  it("말에 단어가 겹쳐도 본문이 자동으로 붙지 않는다", async () => {
    load.mockResolvedValue([{ name: "배포 절차", description: "배포", content: "1. 태그" }]);
    await reloadUserSkills();
    expect(buildKnowledgeSection("배포 어떻게 하지")).toBe("");
    expect(buildKnowledgeSection("그림 그려줘")).toBe("");
  });

  it('"/이름" 으로 직접 부르면 붙는다', async () => {
    load.mockResolvedValue([{ name: "deploy", description: "배포 절차", content: "1. 태그" }]);
    await reloadUserSkills();
    const out = buildKnowledgeSection("/deploy 지금 해줘");
    expect(out).toContain("1. 태그");
    expect(out).toContain("/deploy 으로 직접 불렀어");
  });

  it("배열이 아닌 게 와도 지식 조회가 죽지 않는다", async () => {
    // Tauri 커맨드가 예상 밖의 값을 주면 전개에서 터지고, 그 함수는 요청마다
    // 지나는 길이라 대화 전체가 멈춘다.
    load.mockResolvedValue(null as never);
    expect(await reloadUserSkills()).toBe(0);
    expect(() => buildKnowledgeSection("/그림그리기")).not.toThrow();
    expect(readKnowledge("그림그리기")).not.toBeNull();
  });
});

describe("스킬 목록", () => {
  it("이름과 한 줄 요약만 싣는다 — 본문은 skill.read 로만 온다", async () => {
    load.mockResolvedValue([{ name: "deploy", description: "배포 절차", content: "본문은 목록에 안 실림" }]);
    await reloadUserSkills();
    const index = buildSkillIndex();
    expect(index).toContain("- deploy: 배포 절차");
    expect(index).toContain("- 그림그리기: SVG 로 그림·아이콘·캐릭터 그리기");
    expect(index).not.toContain("본문은 목록에");
  });
});

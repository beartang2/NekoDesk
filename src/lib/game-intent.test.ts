import { describe, it, expect } from "vitest";
import { detectGameIntent } from "./game-intent";

describe("게임 시작 의도", () => {
  it("하자는 말을 알아본다", () => {
    for (const s of ["끝말잇기 하자", "끝말잇기 할래?", "끝말잇기 하고 싶어", "끝말잇기 ㄱㄱ", "끝말잇기 시작해줘", "끝말잇기"]) {
      expect(detectGameIntent(s), s).toBe("wordchain");
    }
    for (const s of ["그림 맞추기 하자", "그림게임 할까", "그림 퀴즈 가자"]) {
      expect(detectGameIntent(s), s).toBe("drawing");
    }
  });

  it("물어보는 건 시작하지 않는다", () => {
    for (const s of ["끝말잇기 규칙이 뭐야", "끝말잇기 어떻게 해", "끝말잇기 방법 알려줘", "그림 맞추기가 뭔데"]) {
      expect(detectGameIntent(s), s).toBeNull();
    }
  });

  it("게임 얘기가 아니면 건드리지 않는다", () => {
    for (const s of ["오늘 할 일 보여줘", "음악 틀어줘", "", "안녕"]) {
      expect(detectGameIntent(s), s).toBeNull();
    }
  });

  it("긴 문장 속에 이름이 스쳐도 시작하지 않는다", () => {
    // 하려던 일을 날려버리면 안 된다.
    const long = "어제 친구랑 끝말잇기 했던 얘기를 정리해서 메모에 저장하고 오늘 일정도 같이 보여줘";
    expect(detectGameIntent(long)).toBeNull();
  });

  it("영어 표기도 받는다", () => {
    expect(detectGameIntent("word chain play")).toBe("wordchain");
  });

  it("전사에서 실제로 새어나간 문장을 잡는다", () => {
    // 이 말에 모델이 game.start 를 안 부르고 채팅으로 게임을 흉내냈다.
    expect(detectGameIntent("끝말잇기 하자")).toBe("wordchain");
  });
});

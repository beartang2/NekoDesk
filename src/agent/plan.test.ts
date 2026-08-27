import { describe, it, expect } from "vitest";
import { Plan } from "./plan";

describe("Plan", () => {
  it("빈 계획은 비어 있다고 말한다", () => {
    const p = new Plan();
    expect(p.isEmpty).toBe(true);
    expect(p.render()).toBe("계획 없음");
  });

  it("체크리스트로 그린다", () => {
    const p = new Plan();
    p.set(["파일 찾기", "내용 읽기", "요약하기"]);
    expect(p.render()).toContain("1. [ ] 파일 찾기");
    expect(p.render()).toContain("남은 단계 3개");
  });

  it("완료하면 표시가 바뀌고 남은 개수가 준다", () => {
    const p = new Plan();
    p.set(["a", "b"]);
    p.complete(1);
    expect(p.render()).toContain("1. [x] a");
    expect(p.render()).toContain("2. [ ] b");
    expect(p.remaining).toBe(1);
  });

  it("전부 끝나면 정리하라고 알린다", () => {
    const p = new Plan();
    p.set(["a"]);
    p.complete(1);
    expect(p.render()).toContain("모든 단계 완료");
  });

  it("계획을 다시 세워도 같은 문구의 완료는 유지된다", () => {
    const p = new Plan();
    p.set(["파일 찾기", "요약하기"]);
    p.complete(1);
    // 모델이 중간 단계를 끼워 넣으며 계획을 다듬는 흔한 경우.
    p.set(["파일 찾기", "내용 읽기", "요약하기"]);

    const steps = p.snapshot();
    expect(steps[0]).toEqual({ text: "파일 찾기", status: "done" });
    expect(steps[1]).toEqual({ text: "내용 읽기", status: "pending" });
  });

  it("범위 밖 번호는 고를 수 있는 범위를 알려준다", () => {
    const p = new Plan();
    p.set(["a", "b"]);
    expect(() => p.complete(5)).toThrow("1~2");
    expect(() => p.complete(0)).toThrow("1~2");
    expect(() => p.complete(1.5)).toThrow();
  });

  it("계획이 없을 때 완료를 부르면 먼저 세우라고 한다", () => {
    expect(() => new Plan().complete(1)).toThrow("plan.set");
  });

  it("빈 문자열은 단계로 세지 않는다", () => {
    const p = new Plan();
    p.set(["a", "", "   ", "b"]);
    expect(p.snapshot()).toHaveLength(2);
  });

  it("계획이 컨텍스트를 잡아먹지 않게 개수와 길이를 자른다", () => {
    const p = new Plan();
    p.set(Array.from({ length: 30 }, (_, i) => `단계 ${i}`.padEnd(300, "!")));
    const steps = p.snapshot();
    expect(steps).toHaveLength(12);
    expect(steps[0].text.length).toBeLessThanOrEqual(120);
  });

  it("snapshot 은 사본이라 밖에서 고쳐도 계획이 안 바뀐다", () => {
    const p = new Plan();
    p.set(["a"]);
    p.snapshot()[0].status = "done";
    expect(p.remaining).toBe(1);
  });
});

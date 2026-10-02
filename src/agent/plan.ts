/**
 * 에이전트 자신의 작업 계획.
 *
 * 사용자용 `todo.*` 와는 별개다. 저것은 DB 에 남는 사용자의 할 일이고, 이것은
 * 이번 요청을 끝내기 위한 단계 목록이라 요청이 끝나면 사라진다.
 *
 * 작은 모델일수록 효과가 크다. 스텝이 쌓이면 원래 무엇을 하려던 참인지 놓치는데,
 * 계획을 툴 결과로 되돌려주면 매 턴 컨텍스트에서 자기 계획을 다시 읽게 된다.
 *
 * 상태를 모듈 전역이 아니라 루프가 들고 있는 이유: 앱이 세션을 병렬로 돌린다.
 * 전역 싱글턴이면 두 대화의 계획이 서로를 덮어쓴다.
 */

export type PlanStepStatus = "pending" | "done";

export interface PlanStep {
  text: string;
  status: PlanStepStatus;
}

/** 계획이 길어지면 계획 자체가 컨텍스트를 잡아먹는다. */
const MAX_STEPS = 12;
const MAX_STEP_CHARS = 120;

export class Plan {
  private steps: PlanStep[] = [];

  get isEmpty(): boolean {
    return this.steps.length === 0;
  }

  /** 현재 계획의 사본. UI 로 넘길 때 쓴다. */
  snapshot(): PlanStep[] {
    return this.steps.map((s) => ({ ...s }));
  }

  /**
   * 계획을 새로 세운다.
   *
   * 이미 있는 계획을 다시 세우면 같은 문구의 단계는 완료 표시를 유지한다.
   * 모델이 중간에 계획을 다듬는 일이 흔한데, 그때마다 진행 상황이 날아가면
   * 이미 한 일을 다시 하게 된다.
   */
  set(texts: string[]): PlanStep[] {
    const doneBefore = new Set(
      this.steps.filter((s) => s.status === "done").map((s) => s.text)
    );
    this.steps = texts
      .map((t) => String(t ?? "").trim())
      .filter(Boolean)
      .slice(0, MAX_STEPS)
      .map((text) => text.slice(0, MAX_STEP_CHARS))
      .map((text) => ({ text, status: doneBefore.has(text) ? "done" : "pending" }));
    return this.snapshot();
  }

  /**
   * 1-기반 번호로 완료 표시. 범위를 벗어나면 이유를 던진다.
   *
   * 계획은 순서대로 가는 목록이라 N번을 끝냈으면 앞 단계도 끝난 것으로 본다.
   * 모델이 단계마다 부르지 않고 마지막에 한 번만 부르는 일이 흔한데, 그러면
   * 마지막 칸 하나만 체크된 채 "1/4" 로 끝났다.
   */
  complete(index: number): PlanStep[] {
    if (this.steps.length === 0) {
      throw new Error("아직 계획이 없어. plan.set 을 먼저 불러.");
    }
    if (!Number.isInteger(index) || index < 1 || index > this.steps.length) {
      throw new Error(`${index}번 단계는 없어. 1~${this.steps.length} 중에서 골라.`);
    }
    for (let i = 0; i < index; i++) this.steps[i].status = "done";
    return this.snapshot();
  }

  get remaining(): number {
    return this.steps.filter((s) => s.status === "pending").length;
  }

  /**
   * 모델에게 되돌려줄 문자열. 매번 계획 **전체**를 다시 그린다 — 바뀐 줄만
   * 알려주면 모델이 나머지를 기억한다고 가정하는 셈인데, 그 가정이 자주 틀린다.
   */
  render(): string {
    if (this.steps.length === 0) return "계획 없음";
    const lines = this.steps.map(
      (s, i) => `${i + 1}. [${s.status === "done" ? "x" : " "}] ${s.text}`
    );
    const remaining = this.remaining;
    const tail =
      remaining === 0
        ? "모든 단계 완료. 결과를 정리해서 답해."
        : `남은 단계 ${remaining}개. 다음 단계를 계속 진행해.`;
    return `${lines.join("\n")}\n${tail}`;
  }
}

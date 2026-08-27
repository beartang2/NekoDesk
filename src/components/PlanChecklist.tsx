import type { PlanStep } from "../agent/plan";
import "./PlanChecklist.css";

/**
 * 에이전트가 세운 작업 계획. 사용자용 할 일 목록이 아니라 "지금 이 요청을 어떻게
 * 끝낼 것인가" 이므로 채팅 메시지 안에 붙는다.
 */
export function PlanChecklist({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) return null;
  const done = steps.filter((s) => s.status === "done").length;

  return (
    <div className="plan-checklist">
      <div className="plan-checklist__header">
        계획 {done}/{steps.length}
      </div>
      <ol className="plan-checklist__list">
        {steps.map((step, i) => (
          <li
            key={`${i}-${step.text}`}
            className={`plan-checklist__item ${
              step.status === "done" ? "plan-checklist__item--done" : ""
            }`}
          >
            <span className="plan-checklist__mark">{step.status === "done" ? "✓" : "○"}</span>
            <span className="plan-checklist__text">{step.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

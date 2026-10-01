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
            {/* reactbits 의 SpringCheck: 네모가 차오르며 살짝 부풀고, 체크가 그려지고,
                한 박자 늦게 줄이 그어진다. 끝난 단계가 "방금 끝났다" 로 읽힌다. */}
            <span className="plan-check" aria-hidden="true">
              <span className="plan-check__ring" />
              <span className="plan-check__fill" />
              <svg className="plan-check__tick" viewBox="0 0 24 24">
                <path d="M6 12.5 10.5 17 18 7.5" pathLength={1} />
              </svg>
            </span>
            <span className="plan-checklist__text">
              {step.text}
              <span className="plan-checklist__rule" />
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

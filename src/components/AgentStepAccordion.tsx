import React, { useState } from "react";
import type { AgentStep } from "../agent/types";
import "./AgentStepAccordion.css";

// ── Status icon ───────────────────────────────────────────────────────────────

function StatusIcon({ status }: { status: AgentStep["status"] }) {
  if (status === "running") return <span className="step-icon step-icon--running">⏳</span>;
  if (status === "done") return <span className="step-icon step-icon--done">✓</span>;
  return <span className="step-icon step-icon--error">✗</span>;
}

// ── Code block ────────────────────────────────────────────────────────────────

function CodeBlock({ value }: { value: unknown }) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, null, 2);

  return (
    <pre className="step-code">
      <code>{text}</code>
    </pre>
  );
}

// ── Single accordion item ─────────────────────────────────────────────────────

interface StepProps {
  step: AgentStep;
  defaultOpen?: boolean;
}

function AgentStepItem({ step, defaultOpen = false }: StepProps) {
  const [open, setOpen] = useState(defaultOpen);

  const toolLabel =
    step.tool === "none" ? "최종 답변" : step.tool;

  return (
    <div className={`step-item step-item--${step.status}`}>
      <button
        className="step-header"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <StatusIcon status={step.status} />
        <span className="step-header__label">
          {step.id}단계: <strong>{toolLabel}</strong>
        </span>
        {step.errorMessage && (
          <span className="step-header__error">{step.errorMessage}</span>
        )}
        <span className="step-header__chevron">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="step-body">
          {step.thought && (
            <section className="step-section">
              <span className="step-section__label">💭 생각</span>
              <p className="step-thought">{step.thought}</p>
            </section>
          )}

          <section className="step-section">
            <span className="step-section__label">📤 Request</span>
            <CodeBlock
              value={{
                tool: step.tool,
                params: step.params,
              }}
            />
          </section>

          {step.result !== null && (
            <section className="step-section">
              <span className="step-section__label">📥 Response</span>
              <CodeBlock value={step.result} />
            </section>
          )}
        </div>
      )}
    </div>
  );
}

// ── Container ─────────────────────────────────────────────────────────────────

interface AgentStepAccordionProps {
  steps: AgentStep[];
  isRunning: boolean;
}

export function AgentStepAccordion({ steps, isRunning }: AgentStepAccordionProps) {
  const [allOpen, setAllOpen] = useState(false);

  if (steps.length === 0) return null;

  return (
    <div className="step-accordion">
      <div className="step-accordion__toolbar">
        <span className="step-accordion__title">
          에이전트 실행 — {steps.length}단계
        </span>
        <button
          className="step-accordion__toggle-all"
          onClick={() => setAllOpen((v) => !v)}
        >
          {allOpen ? "모두 접기" : "모두 펼치기"}
        </button>
      </div>

      <div className="step-accordion__list">
        {steps.map((step, i) => (
          <AgentStepItem
            key={step.id}
            step={step}
            defaultOpen={allOpen}
          />
        ))}
      </div>
    </div>
  );
}

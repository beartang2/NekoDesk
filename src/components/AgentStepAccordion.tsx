import React, { useState } from "react";
import {
  Brain,
  CalendarDays,
  Check,
  ChevronRight,
  CloudSun,
  FileSearch,
  FileText,
  FolderOpen,
  Gamepad2,
  Globe,
  ListChecks,
  MessageCircleQuestion,
  PencilLine,
  Search,
  Send,
  Terminal,
  Upload,
  Users,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AgentStep } from "../agent/types";
import "./AgentStepAccordion.css";

// ── Tool presentation ─────────────────────────────────────────────────────────

/**
 * 툴 이름(`fs.read`)은 모델을 위한 식별자다. 사람에게는 무엇을 했는지로 보여준다.
 * 표에 없는 툴(MCP 등)은 이름 그대로 나온다.
 */
const TOOL_META: Record<string, { label: string; icon: LucideIcon }> = {
  "todo.list": { label: "할 일 확인", icon: ListChecks },
  "todo.list_done": { label: "끝낸 일 확인", icon: ListChecks },
  "todo.add": { label: "할 일 추가", icon: ListChecks },
  "todo.complete": { label: "할 일 완료", icon: ListChecks },
  "schedule.list": { label: "일정 확인", icon: CalendarDays },
  "schedule.add": { label: "일정 추가", icon: CalendarDays },
  "schedule.delete": { label: "일정 삭제", icon: CalendarDays },
  "code.exec": { label: "코드 실행", icon: Terminal },
  "web.search": { label: "웹 검색", icon: Search },
  "web.scrape": { label: "페이지 읽기", icon: Globe },
  "weather.get": { label: "날씨 확인", icon: CloudSun },
  "game.start": { label: "게임 시작", icon: Gamepad2 },
  "file.upload": { label: "파일 업로드", icon: Upload },
  "fs.read": { label: "파일 읽기", icon: FileText },
  "fs.write": { label: "파일 쓰기", icon: PencilLine },
  "fs.edit": { label: "파일 수정", icon: PencilLine },
  "fs.list": { label: "폴더 보기", icon: FolderOpen },
  "fs.glob": { label: "파일 찾기", icon: FileSearch },
  "fs.grep": { label: "내용 검색", icon: FileSearch },
  "memory.save": { label: "기억하기", icon: Brain },
  "memory.search": { label: "기억 떠올리기", icon: Brain },
  "airdrop.send": { label: "AirDrop 보내기", icon: Send },
  "agent.delegate": { label: "조사 맡기기", icon: Users },
  "user.ask": { label: "물어보기", icon: MessageCircleQuestion },
};

/** 행 옆에 붙일 한 줄 요약 — 파라미터 중 사람이 알아볼 만한 첫 번째. */
const SUMMARY_KEYS = ["query", "path", "pattern", "url", "title", "content", "location", "task", "question", "language"];

function summarizeParams(step: AgentStep): string {
  const params = step.params ?? {};
  if (step.tool === "code.exec") {
    const lang = typeof params.language === "string" ? params.language : "";
    const firstLine = typeof params.code === "string" ? params.code.trim().split("\n")[0] : "";
    return [lang, firstLine].filter(Boolean).join(" · ");
  }
  for (const key of SUMMARY_KEYS) {
    const v = params[key];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0];
  }
  return "";
}

function formatValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

// ── Status ────────────────────────────────────────────────────────────────────

function StatusMark({ status }: { status: AgentStep["status"] }) {
  if (status === "running") return <span className="step-spinner" aria-label="실행 중" />;
  if (status === "done") return <Check className="step-mark step-mark--done" size={13} strokeWidth={2.5} aria-label="완료" />;
  return <X className="step-mark step-mark--error" size={13} strokeWidth={2.5} aria-label="실패" />;
}

// ── Single step ───────────────────────────────────────────────────────────────

interface StepProps {
  step: AgentStep;
  isOpen: boolean;
  onToggle: () => void;
}

function AgentStepItem({ step, isOpen, onToggle }: StepProps) {
  const meta = TOOL_META[step.tool];
  const Icon = meta?.icon ?? Wrench;
  const label = step.tool === "none" ? "최종 답변" : meta?.label ?? step.tool;
  const summary = summarizeParams(step);
  // 파라미터가 하나뿐이고 이미 행에 요약으로 보이면 펼쳐도 또 보여줄 필요 없다.
  const allParams = Object.entries(step.params ?? {});
  const paramEntries =
    allParams.length === 1 && formatValue(allParams[0][1]).split("\n")[0].trim() === summary ? [] : allParams;

  return (
    <div className={`step-item step-item--${step.status} ${isOpen ? "step-item--open" : ""}`}>
      {/* 최종 답변 스텝의 생각은 바로 아래 말풍선과 같은 말이라 빼둔다. */}
      {step.thought && step.tool !== "none" && <p className="step-thought">{step.thought}</p>}

      <button className="step-row" onClick={onToggle} aria-expanded={isOpen}>
        <span className="step-row__icon"><Icon size={12} strokeWidth={2} /></span>
        <span className="step-row__text">
          <span className="step-row__label">{label}</span>
          {summary && <span className="step-row__summary">{summary}</span>}
        </span>
        <StatusMark status={step.status} />
        <ChevronRight className="step-row__chevron" size={13} strokeWidth={2} />
      </button>

      {step.status === "error" && step.errorMessage && (
        <p className="step-row__error">{step.errorMessage}</p>
      )}

      <div className={`step-body ${isOpen ? "step-body--open" : ""}`}>
        <div className="step-body__inner">
          {paramEntries.length > 0 && (
            <dl className="step-params">
              {paramEntries.map(([key, value]) => (
                <React.Fragment key={key}>
                  <dt>{key}</dt>
                  <dd>{formatValue(value)}</dd>
                </React.Fragment>
              ))}
            </dl>
          )}

          {step.result !== null && step.result !== undefined && (
            <pre className="step-result"><code>{formatValue(step.result)}</code></pre>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Container ─────────────────────────────────────────────────────────────────

interface AgentStepAccordionProps {
  steps: AgentStep[];
  isRunning: boolean;
}

export function AgentStepAccordion({ steps, isRunning }: AgentStepAccordionProps) {
  const [openIds, setOpenIds] = useState<Set<number>>(new Set());

  if (steps.length === 0) return null;

  const allOpen = openIds.size === steps.length;
  const failed = steps.filter((s) => s.status === "error").length;

  function handleToggle(id: number) {
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setOpenIds(allOpen ? new Set() : new Set(steps.map((s) => s.id)));
  }

  const title = isRunning ? "도구 사용 중" : `도구 ${steps.length}개 사용`;

  return (
    <div className="step-accordion">
      <div className="step-accordion__head">
        <span className="step-accordion__title">
          {title}
          {failed > 0 && <span className="step-accordion__failed"> · 실패 {failed}</span>}
        </span>
        {steps.length > 1 && (
          <button className="step-accordion__toggle-all" onClick={toggleAll}>
            {allOpen ? "모두 접기" : "모두 펼치기"}
          </button>
        )}
      </div>

      <div className="step-accordion__list">
        {steps.map((step) => (
          <AgentStepItem
            key={step.id}
            step={step}
            isOpen={openIds.has(step.id)}
            onToggle={() => handleToggle(step.id)}
          />
        ))}
      </div>
    </div>
  );
}

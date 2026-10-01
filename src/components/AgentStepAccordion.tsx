import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
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
  "game.judge": { label: "판정", icon: Gamepad2 },
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

// ── 상태 표시 ─────────────────────────────────────────────────────────────────
// reactbits 의 CallChip 에서 가져온 방식: 상태가 바뀌면 글리프가 위로 굴러 나가고
// 다음 글리프가 흐릿하게 올라온다. 셋을 겹쳐 두고 둘만 움직인다.

type Glyph = "spin" | "check" | "cross";

function glyphOf(status: AgentStep["status"]): Glyph {
  return status === "done" ? "check" : status === "error" ? "cross" : "spin";
}

function StatusMark({ status }: { status: AgentStep["status"] }) {
  const roll = useRef<{ cur: Glyph; prev: Glyph | null }>({ cur: glyphOf(status), prev: null });
  const next = glyphOf(status);
  if (next !== roll.current.cur) roll.current = { cur: next, prev: roll.current.cur };

  // 지금 글리프는 들어오고, 직전 것만 나간다. 나머지는 자리만 지킨다.
  const state = (g: Glyph) =>
    g === roll.current.cur ? "in" : g === roll.current.prev ? "out" : undefined;

  const label = status === "running" ? "실행 중" : status === "done" ? "완료" : "실패";

  return (
    <span className="step-slot" role="img" aria-label={label}>
      <span className="step-glyph" data-state={state("spin")}>
        <span className="step-spinner" />
      </span>
      <span className="step-glyph step-glyph--done" data-state={state("check")}>
        <Check size={13} strokeWidth={2.5} />
      </span>
      <span className="step-glyph step-glyph--error" data-state={state("cross")}>
        <X size={13} strokeWidth={2.5} />
      </span>
    </span>
  );
}

/**
 * 툴마다 대략 이만큼 걸린다고 보고 진행 막대를 민다.
 *
 * 진짜 진행률을 알 방법은 없다(툴은 끝났는지만 알려준다). 그래서 CallChip 처럼
 * 90% 에서 멈춰 서서 기다리다가, 끝나면 100% 로 채우고 사라진다.
 */
const EXPECTED_MS: Record<string, number> = {
  "web.search": 4000,
  "web.scrape": 6000,
  "code.exec": 3000,
  "agent.delegate": 10000,
  "fs.grep": 2500,
  "fs.glob": 2000,
};
const DEFAULT_EXPECTED_MS = 1500;
/** 끝날 때까지 밀어붙일 최대치. 100% 로 두면 "끝났는데 안 끝났다" 로 보인다. */
const HOLD_AT = 0.9;
const SHAKE = [0, -1, 1, -0.66, 0.66, -0.33, 0];

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/** 이 행이 실행 중이던 시간. 지난 대화를 불러온 행처럼 처음부터 끝나 있으면 null. */
function useElapsed(status: AgentStep["status"]): number | null {
  const startRef = useRef<number | null>(status === "running" ? performance.now() : null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    if (status === "running") {
      startRef.current ??= performance.now();
      return;
    }
    if (startRef.current !== null) {
      setElapsed(performance.now() - startRef.current);
      startRef.current = null;
    }
  }, [status]);

  return elapsed;
}

function formatElapsed(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// ── Single step ───────────────────────────────────────────────────────────────

interface StepProps {
  step: AgentStep;
  isOpen: boolean;
  onToggle: () => void;
}

function AgentStepItem({ step, isOpen, onToggle }: StepProps) {
  const rowRef = useRef<HTMLButtonElement>(null);
  const fillRef = useRef<HTMLSpanElement>(null);
  const elapsed = useElapsed(step.status);

  // 진행 막대. 실행 중에는 예상 시간에 걸쳐 90% 까지 밀고, 끝나면 채운 뒤 걷힌다.
  // 실패하면 그 자리에 멈춘다 — 어디까지 갔는지가 곧 정보다.
  useLayoutEffect(() => {
    const fill = fillRef.current;
    if (!fill) return;
    if (step.status === "running") {
      fill.style.transition = "none";
      fill.style.transform = "scaleX(0)";
      void fill.getBoundingClientRect();
      fill.style.transition = "";
      fill.style.transform = `scaleX(${HOLD_AT})`;
      return;
    }
    if (step.status === "done") {
      fill.style.transform = "scaleX(1)";
      return;
    }
    // 실패: 지금 그려진 자리에 그대로 멈춘다.
    const live = new DOMMatrix(getComputedStyle(fill).transform).a;
    fill.style.transition = "none";
    fill.style.transform = `scaleX(${Math.min(1, Math.max(0, live))})`;
  }, [step.status]);

  // 실패는 한 번 흔들어 알린다. composite: "add" 라 다른 변형과 겹쳐도 안 싸운다.
  useEffect(() => {
    if (step.status !== "error" || !rowRef.current || prefersReducedMotion()) return;
    const anim = rowRef.current.animate(
      SHAKE.map((k) => ({ transform: `translateX(${k * 4}px)`, easing: "cubic-bezier(0.77, 0, 0.175, 1)" })),
      { duration: 420, composite: "add" }
    );
    return () => anim.cancel();
  }, [step.status]);

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

      <button
        ref={rowRef}
        className="step-row"
        onClick={onToggle}
        aria-expanded={isOpen}
        style={{ "--step-expected": `${EXPECTED_MS[step.tool] ?? DEFAULT_EXPECTED_MS}ms` } as React.CSSProperties}
      >
        <span ref={fillRef} className="step-row__fill" aria-hidden="true" />
        <span className="step-row__icon"><Icon size={12} strokeWidth={2} /></span>
        <span className="step-row__text">
          <span className="step-row__label">{label}</span>
          {summary && <span className="step-row__summary">{summary}</span>}
        </span>
        {elapsed !== null && <span className="step-row__time">{formatElapsed(elapsed)}</span>}
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

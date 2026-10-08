import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Archive, ChevronDown, FileText, Pencil, StickyNote, X } from "lucide-react";
import { startDrag } from "@crabnebula/tauri-plugin-drag";
import { todosApi, scheduleApi, settingsApi, shelfApi, type ShelfItem } from "../api/tauri";
import { formatBytes } from "./Attachments";
import { appEvents } from "../lib/events";
import { syncCanvasToBox } from "../lib/canvas";
import { useRevealChildren, useScrollEdges } from "../hooks/useScrollReveal";
import type { Todo, ScheduleEvent } from "../agent/types";
import type { DrawingGameState, DrawingGameActions } from "../hooks/useDrawingGame";
import "./RightPanel.css";

// ── 날짜 파싱 유틸 (캘린더·알림 공용) ──────────────────────────────────────
export function parseEventDate(s: string): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }
  const sqliteDt = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (sqliteDt) {
    return new Date(
      Number(sqliteDt[1]), Number(sqliteDt[2]) - 1, Number(sqliteDt[3]),
      Number(sqliteDt[4]), Number(sqliteDt[5]), Number(sqliteDt[6])
    );
  }
  return new Date(s);
}

/**
 * 시간 없이 날짜만 적힌 일정("2026-11-13"). 자정으로 읽히는데, 그 시각을 그대로 찍으면
 * "오전 12:00" 이 된다 — 종일로 보여야 한다.
 */
export function isDateOnly(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** 일정이 걸친 첫날과 마지막 날(자정 기준). end_at 이 없으면 시작한 하루다. */
export function eventDaySpan(e: { start_at: string; end_at: string | null }): [Date, Date] {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const start = day(parseEventDate(e.start_at));
  const end = e.end_at ? day(parseEventDate(e.end_at)) : start;
  return [start, end < start ? start : end];
}

/** 아코디언 화살표. ▲▼ 글자는 글꼴마다 기준선이 달라 위아래가 틀어져서 SVG 를 돌린다. */
function AccChevron({ up }: { up: boolean }) {
  return (
    <ChevronDown
      size={12}
      strokeWidth={2.25}
      className={`acc-chevron ${up ? "acc-chevron--up" : ""}`}
      aria-hidden="true"
    />
  );
}

// ── TODO Card ─────────────────────────────────────────────────────────────────

// ── Spring check (reactbits SpringCheck) ──────────────────────────────────────
// 원본은 motion 의 스프링과 hugeicons 아이콘을 쓴다. 의존성 없이 같은 스프링
// (visualDuration 0.2s, bounce 0.2)을 닫힌 식으로 풀어 --t 하나만 움직이고,
// 채움·상자 부풂·체크 긋기·글자 흐려짐·줄긋기는 CSS 가 --t 에서 계산한다.

const SPRING_OMEGA = (2 * Math.PI) / (0.2 * 1.2); // motion 이 visualDuration 에서 고르는 고유진동수
const SPRING_ZETA = 0.456; // bounce 0.2 — 20% 넘쳤다가 돌아온다
const SPRING_OMEGA_D = SPRING_OMEGA * Math.sqrt(1 - SPRING_ZETA * SPRING_ZETA);
const SPRING_SETTLE_SEC = 0.5;

/** 0 에서 1 로 가는 스프링의 sec 초 뒤 값. 1.2 까지 넘쳤다가 1 에 선다. */
export function springAt(sec: number): number {
  if (sec >= SPRING_SETTLE_SEC) return 1;
  const decay = Math.exp(-SPRING_ZETA * SPRING_OMEGA * sec);
  const k = (SPRING_ZETA * SPRING_OMEGA) / SPRING_OMEGA_D;
  return 1 - decay * (Math.cos(SPRING_OMEGA_D * sec) + k * Math.sin(SPRING_OMEGA_D * sec));
}

function CheckRow({
  label,
  checked,
  onCheck,
  meta,
  title,
  className = "",
  onAnimationEnd,
}: {
  label: string;
  checked: boolean;
  /** 없으면 보기만 한다(완료 목록). */
  onCheck?: () => void;
  meta?: string | null;
  title?: string;
  className?: string;
  onAnimationEnd?: React.AnimationEventHandler<HTMLLIElement>;
}) {
  const ref = useRef<HTMLLIElement>(null);
  const prev = useRef(checked);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (t: number) => el.style.setProperty("--t", String(t));
    // 스프링은 실제로 바뀌었을 때만. 처음 그릴 때와 움직임 줄이기에선 바로 그 자리.
    const changed = prev.current !== checked;
    prev.current = checked;
    if (!changed || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      set(checked ? 1 : 0);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const p = springAt((now - start) / 1000);
      set(checked ? p : 1 - p);
      if (p !== 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [checked]);

  return (
    <li ref={ref} className={`todo-item ${className}`} title={title} onAnimationEnd={onAnimationEnd}>
      <button
        className="spring-check"
        role="checkbox"
        aria-checked={checked}
        aria-label={label}
        disabled={!onCheck || checked}
        onClick={onCheck}
      >
        <span className="spring-check__fill" />
        <svg className="spring-check__tick" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} />
        </svg>
      </button>
      <span className="todo-item__text">
        <span className="todo-item__word">{label}</span>
        <span className="todo-item__rule" aria-hidden="true" />
      </span>
      {meta && <span className="todo-item__due">{meta}</span>}
    </li>
  );
}

/** 대화 목록과 같은 결(reactbits AnimatedList): 가려진 가장자리는 흐리고, 보이는 줄만 올라온다. */
function TodoList({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLUListElement>(null);
  useScrollEdges(ref);
  useRevealChildren(ref);
  return <ul className="todo-list" ref={ref}>{children}</ul>;
}

function TodoCard() {
  const [todos, setTodos] = useState<Todo[]>([]);
  // 완료한 줄은 바로 빼지 않고 스프링 체크·줄긋기를 보여준 뒤 접혀 나간다.
  const [leaving, setLeaving] = useState<Set<number>>(new Set());
  const [doneTodos, setDoneTodos] = useState<Todo[]>([]);
  const [showDone, setShowDone] = useState(false);

  async function load() {
    try {
      // 예전엔 8개에서 잘라 9번째부터 안 보였다. 목록 높이에 상한을 두고 다 보여준다.
      setTodos(await todosApi.list());
    } catch {}
  }

  async function loadDone() {
    try {
      const result = await todosApi.listDone();
      setDoneTodos(result.slice(0, 20));
    } catch {}
  }

  useEffect(() => {
    load();
    return appEvents.on("agentDone", () => load());
  }, []);

  useEffect(() => {
    if (showDone) loadDone();
  }, [showDone]);

  function unmarkLeaving(id: number) {
    setLeaving((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  // 누르는 순간 체크한다(응답을 기다리면 손맛이 죽는다). 저장이 실패하면 스프링이 되돌아간다.
  function complete(id: number) {
    setLeaving((prev) => new Set(prev).add(id));
    todosApi
      .complete(id)
      .then(() => { if (showDone) loadDone(); })
      .catch(() => unmarkLeaving(id));
  }

  function removeLeft(id: number) {
    setTodos((prev) => prev.filter((t) => t.id !== id));
    unmarkLeaving(id);
  }

  return (
    <div className="panel-card">
      <div className="panel-card__header">
        ✓ TODO List
        <button
          className="todo-done-toggle"
          onClick={() => setShowDone((v) => !v)}
          title={showDone ? "할 일 보기" : "완료 목록 보기"}
        >
          {showDone ? "미완료" : "완료"}
        </button>
      </div>
      <div className="panel-card__body">
        {showDone ? (
          doneTodos.length === 0 ? (
            <span className="panel-empty">완료된 할 일 없음</span>
          ) : (
            <TodoList>
              {doneTodos.map((t) => (
                <CheckRow
                  key={t.id}
                  label={t.content}
                  checked
                  meta={t.completed_at?.slice(5, 10)}
                  title={t.completed_at ? `완료: ${t.completed_at.slice(0, 10)}` : t.content}
                />
              ))}
            </TodoList>
          )
        ) : todos.length === 0 ? (
          <span className="panel-empty">할 일 없음</span>
        ) : (
          <TodoList>
            {todos.map((t) => (
              <CheckRow
                key={t.id}
                label={t.content}
                checked={leaving.has(t.id)}
                onCheck={() => complete(t.id)}
                meta={t.due_at?.slice(5, 10)}
                title={t.due_at ? `${t.content}\n기한: ${t.due_at.slice(0, 10)}` : t.content}
                className={leaving.has(t.id) ? "todo-item--leaving" : ""}
                onAnimationEnd={(e) => { if (e.animationName === "todo-leave") removeLeft(t.id); }}
              />
            ))}
          </TodoList>
        )}
      </div>
    </div>
  );
}

// ── Calendar Card ─────────────────────────────────────────────────────────────

const CAL_COLLAPSED_KEY = "nekodesk_calendar_collapsed";
/** 이만큼(px) 가로로 밀면 넘긴다. 작으면 세로로 굴리다 살짝 비낀 것에도 넘어간다. */
const SWIPE_THRESHOLD = 40;
/** wheel 이 이만큼 끊기면 손을 뗀 것으로 본다(관성 포함). */
const SWIPE_IDLE_MS = 200;
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

function CalendarCard() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [selectedDay, setSelectedDay] = useState<number | null>(today.getDate());
  // 접으면 달 이름과 한 주(이번 주, 또는 고른 날이 있는 주)만 남는다. 껐다 켜도 기억한다.
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(CAL_COLLAPSED_KEY) === "1");

  function toggleCollapsed() {
    setCollapsed((v) => {
      localStorage.setItem(CAL_COLLAPSED_KEY, v ? "0" : "1");
      return !v;
    });
  }

  async function loadEvents() {
    try {
      const result = await scheduleApi.list("all");
      setEvents(result);
    } catch {}
  }

  useEffect(() => {
    loadEvents();
    return appEvents.on("agentDone", () => loadEvents());
  }, []);

  const [calKey, setCalKey] = useState(0);
  const [calDir, setCalDir] = useState<"next" | "prev">("next");

  function prevMonth() {
    setCalDir("prev"); setCalKey((k) => k + 1);
    if (month === 0) { setYear((y) => y - 1); setMonth(11); }
    else setMonth((m) => m - 1);
    setSelectedDay(null);
  }

  function nextMonth() {
    setCalDir("next"); setCalKey((k) => k + 1);
    if (month === 11) { setYear((y) => y + 1); setMonth(0); }
    else setMonth((m) => m + 1);
    setSelectedDay(null);
  }

  // 여러 날 일정은 시작한 날만이 아니라 걸친 날마다 보여야 한다.
  const covers = (e: ScheduleEvent, day: number) => {
    const [start, end] = eventDaySpan(e);
    const d = new Date(year, month, day);
    return d >= start && d <= end;
  };
  const monthStart = new Date(year, month, 1);
  const monthEnd = new Date(year, month + 1, 0);
  const monthEvents = events.filter((e) => {
    const [start, end] = eventDaySpan(e);
    return !isNaN(start.getTime()) && start <= monthEnd && end >= monthStart;
  });

  // Calendar grid (Sun-first)
  const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0=Sun
  const startOffset = firstDayOfWeek; // 0=Sun
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (number | null)[] = [
    ...Array(startOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const selectedEvents = selectedDay
    ? monthEvents.filter((e) => covers(e, selectedDay))
    : [];

  const isCurrentMonthView =
    year === today.getFullYear() && month === today.getMonth();

  // 접혔을 때 보일 주: 고른 날 → 오늘(이번 달일 때) → 그달 첫 주.
  const anchorDay = selectedDay ?? (isCurrentMonthView ? today.getDate() : 1);
  const weekStart = Math.floor((startOffset + anchorDay - 1) / 7) * 7;

  /** 고른 날을 한 주 옮긴다. 달이 바뀌면 달도 넘기고, 같은 달이면 주가 위아래로 미끄러진다. */
  function stepWeek(dir: 1 | -1) {
    const d = new Date(year, month, anchorDay + dir * 7);
    if (d.getMonth() !== month || d.getFullYear() !== year) {
      setCalDir(dir > 0 ? "next" : "prev");
      setCalKey((k) => k + 1);
      setYear(d.getFullYear());
      setMonth(d.getMonth());
    }
    setSelectedDay(d.getDate());
  }

  // 트랙패드 두 손가락 가로 스와이프: 접혀 있으면 한 주, 펼쳐 있으면 한 달.
  // 손을 떼도 관성으로 wheel 이 한참 더 오므로, 이벤트가 잠잠해질 때까지 한 번만 넘긴다.
  const swipe = useRef<{ sum: number; locked: boolean; timer?: ReturnType<typeof setTimeout> }>({
    sum: 0,
    locked: false,
  });
  function onWheel(e: React.WheelEvent) {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    const s = swipe.current;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      s.sum = 0;
      s.locked = false;
    }, SWIPE_IDLE_MS);
    if (s.locked) return;
    s.sum += e.deltaX;
    if (Math.abs(s.sum) < SWIPE_THRESHOLD) return;
    s.locked = true;
    const dir = s.sum > 0 ? 1 : -1; // 손가락을 왼쪽으로 = 다음
    if (collapsed) stepWeek(dir);
    else if (dir > 0) nextMonth();
    else prevMonth();
  }

  return (
    <div className="panel-card panel-card--calendar" onWheel={onWheel}>
      <div className="panel-card__header cal-header">
        <span>📅 캘린더</span>
        <div className="cal-nav">
          <button className="cal-nav__btn" onClick={prevMonth}>‹</button>
          <span className="cal-nav__label">{MONTH_NAMES[month]} {year}</span>
          <button className="cal-nav__btn" onClick={nextMonth}>›</button>
          <button
            className="cal-nav__btn"
            onClick={toggleCollapsed}
            title={collapsed ? "달력 펼치기" : "이번 주만 보기"}
            aria-expanded={!collapsed}
          >
            <AccChevron up={!collapsed} />
          </button>
        </div>
      </div>
      <div className="panel-card__body">
        <div key={calKey} className={`cal-slide cal-slide--${calDir}`}>
          <div className="cal-grid cal-grid--labels">
            {DAY_LABELS.map((d) => (
              <div key={d} className="cal-cell cal-cell--label">{d}</div>
            ))}
          </div>
          {/* 주는 늘 다 그려 두고, 접으면 상자가 한 주 높이로 줄며 그 주로 올라간다. */}
          <div
            className={`cal-weeks ${collapsed ? "cal-weeks--collapsed" : ""}`}
            style={{ "--rows": cells.length / 7, "--week": weekStart / 7 } as React.CSSProperties}
          >
            <div className="cal-grid cal-weeks__inner">
              {cells.map((day, i) => {
                if (!day) return <div key={`_${i}`} className="cal-cell" />;
                const isToday = isCurrentMonthView && day === today.getDate();
                const hasEvent = monthEvents.some((e) => covers(e, day));
                const isSelected = day === selectedDay;
                return (
                  <div
                    key={day}
                    className={[
                      "cal-cell",
                      "cal-cell--day",
                      isToday ? "cal-cell--today" : "",
                      isSelected ? "cal-cell--selected" : "",
                    ].filter(Boolean).join(" ")}
                    onClick={() => setSelectedDay(day === selectedDay ? null : day)}
                  >
                    {day}
                    {hasEvent && <span className="cal-dot" />}
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`acc-wrap cal-events-wrap ${selectedDay && !collapsed ? "acc-wrap--open" : ""}`}>
            <div className="acc-inner">
              {selectedDay && (
                <div className="cal-events">
                  {selectedEvents.length === 0 ? (
                    <span className="panel-empty">{month + 1}/{selectedDay} 일정 없음</span>
                  ) : (
                    selectedEvents.map((e) => (
                      <div
                        key={e.id}
                        className="cal-event"
                        title={[
                          e.title,
                          e.end_at && !e.all_day && !isDateOnly(e.start_at)
                            ? `${parseEventDate(e.start_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} ~ ${parseEventDate(e.end_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`
                            : null,
                          e.notes,
                        ].filter(Boolean).join("\n")}
                      >
                        <span className="cal-event__time">
                          {/* 여러 날이면 기간이 제일 많이 말해준다. 종일 일정이어도 기간을 보인다. */}
                          {eventDaySpan(e)[1] > eventDaySpan(e)[0]
                            ? eventDaySpan(e).map((d) => `${d.getMonth() + 1}/${d.getDate()}`).join("~")
                            : e.all_day || isDateOnly(e.start_at)
                            ? "종일"
                            : parseEventDate(e.start_at).toLocaleTimeString("ko-KR", {
                                hour: "2-digit",
                                minute: "2-digit",
                              })}
                        </span>
                        <span className="cal-event__title">{e.title}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pomodoro Card ─────────────────────────────────────────────────────────────

type PomodoroMode = "focus" | "break" | "long-break" | "custom";

const POMODORO_DURATIONS: Record<Exclude<PomodoroMode, "custom">, number> = {
  focus: 25 * 60,
  break: 5 * 60,
  "long-break": 15 * 60,
};

/** ⇄ 로 도는 순서. 긴 휴식은 자동으로만 들어오고, 거기서 누르면 집중으로 간다. */
const MODE_CYCLE: PomodoroMode[] = ["focus", "break", "custom"];

function formatTime(secs: number) {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/** 타이머가 끝나면 네코가 알린다 — 소리 나는 macOS 알림과 고양이 말풍선. */
function notifyTimerDone(body: string) {
  // notifyIfAway 가 아니라 늘 띄운다. 창을 보고 있어도 타이머 끝은 놓치면 안 된다.
  invoke("notify_user", { title: "네코", body, sound: true }).catch(() => {});
  appEvents.emit("timerDone", body);
}

export function PomodoroCard() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PomodoroMode>("focus");
  const [secondsLeft, setSecondsLeft] = useState(POMODORO_DURATIONS.focus);
  const [isRunning, setIsRunning] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);
  const [customMinutes, setCustomMinutes] = useState("10");
  const [customSecs, setCustomSecs] = useState(10 * 60);
  const durationOf = (m: PomodoroMode) => (m === "custom" ? customSecs : POMODORO_DURATIONS[m]);

  // 1초마다 하나씩 깎으면 창이 뒤로 가 타이머가 느려질 때 같이 늦는다.
  // 끝나는 시각을 정해두고 매번 남은 시간을 다시 잰다.
  useEffect(() => {
    if (!isRunning) return;
    const endsAt = Date.now() + secondsLeft * 1000;
    const id = setInterval(() => {
      const left = Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
      setSecondsLeft(left);
      if (left === 0) {
        clearInterval(id);
        setIsRunning(false);
        handleComplete();
      }
    }, 250);
    return () => clearInterval(id);
    // 도는 동안 mode·남은 시간이 바뀌는 길은 모두 먼저 멈춘다 — 시작 시점 값이면 된다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRunning]);

  function handleComplete() {
    if (mode === "custom") {
      notifyTimerDone(`⏰ ${customSecs / 60}분 타이머 끝! 시간 다 됐어요.`);
      setSecondsLeft(customSecs);
      return;
    }
    const next = mode === "focus" ? sessionCount + 1 : sessionCount;
    const nextMode: PomodoroMode =
      mode === "focus" ? (next % 4 === 0 ? "long-break" : "break") : "focus";
    notifyTimerDone(
      mode === "focus"
        ? `집중 완료! ${nextMode === "long-break" ? "☕ 긴 휴식 시간이에요." : "🍵 잠깐 쉬어가요."}`
        : "휴식 끝! 🐱 다시 집중해볼까요?"
    );
    setSessionCount(next);
    setMode(nextMode);
    setSecondsLeft(POMODORO_DURATIONS[nextMode]);
  }

  function switchTo(next: PomodoroMode, secs = durationOf(next)) {
    setIsRunning(false);
    setMode(next);
    setSecondsLeft(secs);
  }

  function editCustomMinutes(raw: string) {
    setCustomMinutes(raw);
    const minutes = Math.round(Number(raw));
    if (minutes >= 1 && minutes <= 999) {
      setCustomSecs(minutes * 60);
      setSecondsLeft(minutes * 60);
    }
  }

  // 커스텀이고 아직 시작 전이면 시간 자리에서 바로 분을 고친다.
  const editingCustom = mode === "custom" && !isRunning && secondsLeft === customSecs;

  const total = durationOf(mode);
  const progress = (total - secondsLeft) / total;
  const circumference = 2 * Math.PI * 28;
  const modeLabel =
    mode === "focus" ? "집중" : mode === "break" ? "휴식" : mode === "long-break" ? "긴 휴식" : "타이머";

  return (
    <div className="panel-card">
      <button className="panel-card__header pomo-header" onClick={() => setOpen((v) => !v)}>
        <span>⏱ 포모도로</span>
        <span className="pomo-header-right">
          {!open && <span className="pomo-header-time">{formatTime(secondsLeft)}</span>}
          <span className="pomo-session-count">{sessionCount}세션</span>
          <AccChevron up={open} />
        </span>
      </button>
      <div className={`acc-wrap ${open ? "acc-wrap--open" : ""}`}>
        <div className="acc-inner">
          <div className="panel-card__body pomo-body">
            <div className="pomo-ring-wrap">
              <svg className="pomo-ring" viewBox="0 0 64 64" width="64" height="64">
                <circle className="pomo-ring__track" cx="32" cy="32" r="28" />
                <circle
                  className={`pomo-ring__fill pomo-ring__fill--${mode}`}
                  cx="32" cy="32" r="28"
                  strokeDasharray={circumference}
                  strokeDashoffset={circumference * (1 - progress)}
                />
              </svg>
              {editingCustom ? (
                <label className="pomo-time pomo-time--edit">
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={customMinutes}
                    onChange={(e) => editCustomMinutes(e.target.value)}
                    onBlur={() => setCustomMinutes(String(customSecs / 60))}
                    onKeyDown={(e) => { if (e.key === "Enter") setIsRunning(true); }}
                    aria-label="타이머 분"
                  />
                  분
                </label>
              ) : (
                <div className="pomo-time">{formatTime(secondsLeft)}</div>
              )}
            </div>
            <div className="pomo-mode-label">{modeLabel}</div>
            <div className="pomo-controls">
              <button className="pomo-btn" onClick={() => switchTo(mode)} title="리셋">↺</button>
              <button className="pomo-btn pomo-btn--primary" onClick={() => setIsRunning((v) => !v)}>
                {isRunning ? "⏸" : "▶"}
              </button>
              <button
                className="pomo-btn"
                onClick={() => switchTo(MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length])}
                title="모드 전환"
              >
                ⇄
              </button>
            </div>
            <div className="pomo-dots">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className={`pomo-dot ${i < (sessionCount % 4) ? "pomo-dot--filled" : ""}`} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Drawing Pad Card ──────────────────────────────────────────────────────────

const DRAW_COLORS = [
  "#1c1c1e", // off-black
  "#ff6b6b", // coral
  "#ff9f43", // peach
  "#ffd93d", // warm yellow
  "#6bcb77", // mint green
  "#4d96ff", // sky blue
  "#c77dff", // lavender
  "#f8a5c2", // blush pink
  "#ffffff",  // white
];

export function DrawingPadCard({
  gameMode,
}: {
  gameMode?: (DrawingGameState & DrawingGameActions) | null;
}) {
  const MAX_CANVAS_H = 600;

  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState("#111111");
  const [thick, setThick] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [canvasHeight, setCanvasHeight] = useState(160);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isDrawingRef = useRef(false);
  const lastPtRef = useRef<{ x: number; y: number } | null>(null);
  const undoStackRef = useRef<ImageData[]>([]);
  const redoStackRef = useRef<ImageData[]>([]);

  const isGameActive = !!(gameMode && gameMode.phase !== "idle");

  function onResizeMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startY = e.clientY;
    // 자리가 모자라 캔버스가 줄어 있으면 상태값이 아니라 보이는 높이에서 시작한다.
    // 안 그러면 내려도 한동안 그대로인 구간이 생긴다.
    const wrapper = (e.currentTarget as HTMLElement).nextElementSibling as HTMLElement | null;
    const startH = wrapper?.offsetHeight ?? canvasHeight;
    function onMouseMove(ev: MouseEvent) {
      const delta = startY - ev.clientY;
      setCanvasHeight(Math.max(80, Math.min(MAX_CANVAS_H, startH + delta)));
    }
    function onMouseUp() {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  }

  function getCtx() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return canvas.getContext("2d");
  }

  // 비트맵을 보이는 영역에 맞춘다. 예전에는 500×600 고정 비트맵을 wrapper 로 잘라
  // 보여줘서, 사용자가 못 본 흰 여백까지 toDataURL 에 실려 나갔다.
  //
  // 감시는 ref 콜백에서 건다. effect + 의존성 배열로 하면 "캔버스가 언제 바뀌는지"
  // 를 사람이 맞춰야 하는데, 실제로 틀렸었다 — isGameActive 는 setup 단계에서
  // 이미 true 가 되고 그때는 캔버스가 없다. 다음 단계에서 캔버스가 붙어도 의존성은
  // 그대로라 effect 가 다시 안 돌았고, 게임 캔버스는 300×150(기본값) 비트맵을
  // 5:6 박스에 늘여 보여줬다. 콜백은 엘리먼트가 실제로 붙고 떨어질 때만 불린다.
  const observerRef = useRef<ResizeObserver | null>(null);
  const attachCanvas = useCallback((el: HTMLCanvasElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    canvasRef.current = el;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      // 되돌리기 스냅샷은 이전 크기라 새 캔버스에 맞지 않는다.
      if (syncCanvasToBox(el)) {
        undoStackRef.current = [];
        redoStackRef.current = [];
      }
    });
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  // 게임 round 변경 시 캔버스 초기화
  useEffect(() => {
    if (!gameMode || gameMode.phase !== "playing") return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    undoStackRef.current = [];
    redoStackRef.current = [];
  }, [gameMode?.round, gameMode?.phase]);

  // 시간 초과 시 캔버스 자동 제출
  useEffect(() => {
    if (!gameMode?.timedOut) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    gameMode.submitDrawing(dataUrl);
  }, [gameMode?.timedOut]);

  function getPos(e: React.MouseEvent<HTMLCanvasElement>) {
    const rect = canvasRef.current!.getBoundingClientRect();
    const scaleX = canvasRef.current!.width / rect.width;
    const scaleY = canvasRef.current!.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  function onMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    const ctx = getCtx();
    const canvas = canvasRef.current;
    if (!ctx || !canvas) return;
    // undo 스택에 현재 상태 저장
    undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    redoStackRef.current = [];
    isDrawingRef.current = true;
    const pt = getPos(e);
    lastPtRef.current = pt;
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, (thick ? 6 : 2) / 2, 0, Math.PI * 2);
    ctx.fillStyle = tool === "eraser" ? "#ffffff" : color;
    ctx.fill();
  }

  function onMouseMove(e: React.MouseEvent<HTMLCanvasElement>) {
    if (!isDrawingRef.current) return;
    const ctx = getCtx();
    const last = lastPtRef.current;
    if (!ctx || !last) return;
    const pt = getPos(e);
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.strokeStyle = tool === "eraser" ? "#ffffff" : color;
    ctx.lineWidth = thick ? 6 : 2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    lastPtRef.current = pt;
  }

  function onMouseUp() {
    isDrawingRef.current = false;
    lastPtRef.current = null;
  }

  function clearCanvas() {
    const canvas = canvasRef.current;
    const ctx = getCtx();
    if (!canvas || !ctx) return;
    undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    redoStackRef.current = [];
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function undoCanvas() {
    const canvas = canvasRef.current;
    const ctx = getCtx();
    if (!canvas || !ctx || undoStackRef.current.length === 0) return;
    const current = ctx.getImageData(0, 0, canvas.width, canvas.height);
    redoStackRef.current.push(current);
    const prev = undoStackRef.current.pop()!;
    ctx.putImageData(prev, 0, 0);
  }

  async function saveImage() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // 비트맵이 곧 보이는 영역이라 잘라낼 게 없다. 예전에는 500px 폭으로 잘랐는데
    // 실제로 보이는 폭은 패널 너비라, 저장한 그림 오른쪽이 늘 빈 여백이었다.
    const dataUrl = canvas.toDataURL("image/png");
    try {
      await invoke<string>("save_canvas_image", { dataUrl });
      setSaveMsg("✓");
      window.setTimeout(() => setSaveMsg(null), 2000);
    } catch (err) {
      setSaveMsg("✕");
      window.setTimeout(() => setSaveMsg(null), 2000);
    }
  }

  function handleSubmitDrawing() {
    if (!gameMode) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    gameMode.submitDrawing(dataUrl);
  }

  // 게임 모드에서 보여줄 색상 (mono면 흑백만)
  const gameColors = gameMode?.config.mode === "mono"
    ? ["#1c1c1e", "#ffffff"]
    : DRAW_COLORS;

  // 현재 열림 상태: 게임 활성 시 강제 open
  const isOpen = isGameActive ? true : open;

  // ── 게임 모드 헤더 렌더 ──────────────────────────────────────────────────────

  function renderGameHeader() {
    if (!gameMode) return null;
    const { phase, currentEmoji, currentWord, timeLeft, round, totalRounds, guessResult, isCorrect } = gameMode;

    if (phase === "setup") {
      return (
        <div className="draw-header-title">
          <span>🎮 그림 맞추기</span>
        </div>
      );
    }
    if (phase === "playing") {
      const urgent = timeLeft <= 10;
      return (
        <div className="draw-header-title" style={{ gap: 6, flex: 1 }}>
          <span className="draw-game-emoji" title={currentWord}>{currentEmoji}</span>
          <span className={`draw-game-timer${urgent ? " draw-game-timer--urgent" : ""}`}>{timeLeft}s</span>
          <span className="draw-game-rounds">{round}/{totalRounds}</span>
        </div>
      );
    }
    if (phase === "guessing") {
      return <div className="draw-header-title"><span className="draw-game-word">추리 중...</span></div>;
    }
    if (phase === "round_result") {
      return (
        <div className="draw-header-title">
          <span className={isCorrect ? "draw-game-result--ok" : "draw-game-result--ng"}>
            {isCorrect ? "✓" : "✗"} {guessResult}
            {!isCorrect && <span className="draw-game-answer">정답 {currentEmoji} {currentWord}</span>}
          </span>
        </div>
      );
    }
    if (phase === "done") {
      return <div className="draw-header-title"><span>게임 종료</span></div>;
    }
    return null;
  }

  // ── 게임 모드 바디 렌더 ──────────────────────────────────────────────────────

  function renderGameBody() {
    if (!gameMode) return null;
    const { phase, config, score, totalRounds } = gameMode;

    if (phase === "setup") {
      return (
        <div className="draw-game-setup">
          <div className="draw-game-row">
            <span className="draw-game-label">모드</span>
            <button
              className={`draw-game-opt${config.mode === "mono" ? " draw-game-opt--on" : ""}`}
              onClick={() => gameMode.updateConfig({ ...config, mode: "mono" })}
            >
              흑백<span className="draw-game-opt-sub">mono</span>
            </button>
            <button
              className={`draw-game-opt${config.mode === "color" ? " draw-game-opt--on" : ""}`}
              onClick={() => gameMode.updateConfig({ ...config, mode: "color" })}
            >
              컬러<span className="draw-game-opt-sub">color</span>
            </button>
          </div>
          <div className="draw-game-row">
            <span className="draw-game-label">라운드</span>
            {([3, 5] as const).map((n) => (
              <button
                key={n}
                className={`draw-game-opt${config.rounds === n ? " draw-game-opt--on" : ""}`}
                onClick={() => gameMode.updateConfig({ ...config, rounds: n })}
              >
                {n}판
              </button>
            ))}
          </div>
          <button
            className="draw-game-btn draw-game-btn--primary"
            onClick={() => gameMode.startGame(config)}
          >
            시작하기
          </button>
        </div>
      );
    }

    if (phase === "done") {
      return (
        <div className="draw-game-setup">
          <div className="draw-game-score">{totalRounds}판 중 {score}판 맞췄어!</div>
          <div className="draw-game-row" style={{ justifyContent: "center" }}>
            <button className="draw-game-btn" onClick={() => gameMode.startSetup()}>다시</button>
            <button className="draw-game-btn" onClick={() => gameMode.resetGame()}>닫기</button>
          </div>
        </div>
      );
    }

    // playing / guessing / round_result — canvas + toolbar
    const canvasLocked = phase === "guessing" || phase === "round_result";
    return (
      <div className="draw-body">
        <canvas
          ref={attachCanvas}
          className={`draw-canvas draw-canvas--game${canvasLocked ? " draw-canvas--locked" : ""}`}
          onMouseDown={canvasLocked ? undefined : onMouseDown}
          onMouseMove={canvasLocked ? undefined : onMouseMove}
          onMouseUp={canvasLocked ? undefined : onMouseUp}
          onMouseLeave={canvasLocked ? undefined : onMouseUp}
        />
        {!canvasLocked && (
          <div className="draw-game-toolbar">
            <button className="draw-tool-btn" onClick={undoCanvas} title="실행취소">↩</button>
            <button className="draw-tool-btn" onClick={clearCanvas} title="전체 지우기">✕</button>
            <button
              className={`draw-tool-btn ${tool === "eraser" ? "draw-tool-btn--active" : ""}`}
              onClick={() => setTool((t) => t === "eraser" ? "pen" : "eraser")}
              title="지우개"
            >⌫</button>
            <button
              className={`draw-tool-btn ${thick ? "draw-tool-btn--active" : ""}`}
              onClick={() => setThick((v) => !v)}
              title={thick ? "굵게" : "얇게"}
            >{thick ? "●" : "•"}</button>
            <div className="draw-colors">
              {gameColors.map((c) => (
                <button
                  key={c}
                  className={`draw-color-btn ${color === c && tool === "pen" ? "draw-color-btn--active" : ""}`}
                  style={{ background: c, border: c === "#ffffff" ? "1px solid var(--border)" : "none" }}
                  onClick={() => { setColor(c); setTool("pen"); }}
                  title={c}
                />
              ))}
            </div>
            <button
              className="draw-game-btn draw-game-btn--primary draw-game-action"
              onClick={handleSubmitDrawing}
            >제출</button>
          </div>
        )}
        {phase === "round_result" && (
          <div className="draw-game-toolbar">
            <button
              className="draw-game-btn draw-game-btn--primary draw-game-action"
              onClick={() => gameMode.nextRound()}
            >
              {gameMode.round >= gameMode.totalRounds ? "결과" : "다음 →"}
            </button>
          </div>
        )}
      </div>
    );
  }

  // ── Normal mode (no game) ──────────────────────────────────────────────────

  // 캔버스가 떠 있는 동안에만 카드가 패널 높이를 차지한다. 설정 화면까지 늘리면
  // 버튼 몇 개짜리 폼이 빈 카드 안에 덩그러니 남는다.
  const canvasOnScreen =
    !!gameMode && (gameMode.phase === "playing" || gameMode.phase === "guessing" || gameMode.phase === "round_result");

  return (
    <div className={`panel-card ${canvasOnScreen ? "panel-card--game" : "panel-card--draw"}`}>
      <button
        className="panel-card__header pomo-header"
        onClick={() => !isGameActive && setOpen((v) => !v)}
        style={isGameActive ? { cursor: "default" } : undefined}
      >
        {isGameActive ? renderGameHeader() : (
          <span className="draw-header-title"><Pencil size={10} strokeWidth={2} /> 그림판</span>
        )}
        {isGameActive ? (
          <button
            className="draw-game-close-btn"
            onClick={(e) => { e.stopPropagation(); gameMode!.resetGame(); }}
            title="게임 닫기"
          >
            <X size={12} strokeWidth={2} />
          </button>
        ) : (
          <AccChevron up={!open} />
        )}
      </button>
      <div className={`acc-wrap ${isOpen ? "acc-wrap--open" : ""}`}>
        <div className="acc-inner">
          {isGameActive ? (
            renderGameBody()
          ) : (
            <div className="panel-card__body draw-body">
              <div className="draw-resize-handle" onMouseDown={onResizeMouseDown} onDoubleClick={() => setCanvasHeight(160)} />
              <div className="draw-canvas-wrapper" style={{ height: `${canvasHeight}px` }}>
                <canvas
                  ref={attachCanvas}
                  className="draw-canvas"
                  onMouseDown={onMouseDown}
                  onMouseMove={onMouseMove}
                  onMouseUp={onMouseUp}
                  onMouseLeave={onMouseUp}
                />
              </div>
              <div className="draw-colors">
                {DRAW_COLORS.map((c) => (
                  <button
                    key={c}
                    className={`draw-color-btn ${color === c && tool === "pen" ? "draw-color-btn--active" : ""}`}
                    style={{ background: c, border: c === "#ffffff" ? "1px solid var(--border)" : "none" }}
                    onClick={() => { setColor(c); setTool("pen"); }}
                    title={c}
                  />
                ))}
              </div>
              <div className="draw-tools">
                <button
                  className={`draw-tool-btn ${thick ? "draw-tool-btn--active" : ""}`}
                  onClick={() => setThick((v) => !v)}
                  title={thick ? "굵게 (현재)" : "얇게 (현재)"}
                >
                  {thick ? "●" : "•"}
                </button>
                <button
                  className={`draw-tool-btn ${tool === "eraser" ? "draw-tool-btn--active" : ""}`}
                  onClick={() => setTool((t) => t === "eraser" ? "pen" : "eraser")}
                  title="지우개"
                >
                  ⌫
                </button>
                <button className="draw-tool-btn" onClick={clearCanvas} title="전체 지우기">✕</button>
                <button
                  className="draw-tool-btn draw-tool-btn--save"
                  onClick={saveImage}
                  title="PNG로 저장"
                >
                  {saveMsg ?? "↓"}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Memo Card ─────────────────────────────────────────────────────────────────

const MEMO_KEY = "memo";

/** 아무렇게나 적어두는 칸. 적는 대로 DB 에 저장한다. */
function MemoCard() {
  const [text, setText] = useState<string | null>(null); // null = 아직 못 읽음
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    settingsApi.get(MEMO_KEY).then((v) => setText(v ?? "")).catch(() => setText(""));
  }, []);

  // 타이핑이 멈추면, 포커스를 잃으면, 패널이 닫히면 쓴다. 마지막 몇 글자를 잃지 않게.
  function flush() {
    clearTimeout(timer.current);
    if (pending.current === null) return;
    settingsApi.set(MEMO_KEY, pending.current).catch(console.warn);
    pending.current = null;
  }

  useEffect(() => flush, []);

  function edit(v: string) {
    setText(v);
    pending.current = v;
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, 400);
  }

  // 정사각형을 가로로 반 갈라 위는 메모, 아래는 임시 보관함.
  return (
    <div className="panel-card panel-card--memo">
      <div className="memo-half">
        <div className="panel-card__header">
          <span className="draw-header-title"><StickyNote size={10} strokeWidth={2} /> 메모</span>
        </div>
        <div className="panel-card__body">
          <textarea
            className="memo-input"
            value={text ?? ""}
            disabled={text === null}
            onChange={(e) => edit(e.target.value)}
            onBlur={flush}
            placeholder="메모하기"
            spellCheck={false}
          />
        </div>
      </div>
      <Shelf />
    </div>
  );
}

// ── Shelf (임시 보관함) ───────────────────────────────────────────────────────

/** 끌고 갈 때 커서에 붙는 그림. 한 번만 그린다. */
let dragIcon: string | null = null;
function shelfDragIcon(): string {
  if (dragIcon) return dragIcon;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = "48px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("📄", 32, 36);
  }
  return (dragIcon = canvas.toDataURL("image/png"));
}

/**
 * 끌어다 놓은 파일을 지우기 전까지 들고 있는다. 끌어내면 macOS 드래그로 진짜 파일이
 * 넘어가서 Finder·메신저 같은 다른 앱에도, 이 창의 채팅에도 첨부된다.
 */
function Shelf() {
  const [items, setItems] = useState<ShelfItem[]>([]);
  const [over, setOver] = useState(false);
  // 여기서 끌어낸 파일을 도로 여기 놓으면 같은 파일이 하나 더 생긴다. 그동안은 받지 않는다.
  const draggingOut = useRef(false);

  const refresh = useCallback(() => {
    shelfApi.list().then(setItems).catch(() => {});
  }, []);
  useEffect(refresh, [refresh]);

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation(); // 채팅 첨부(window 의 drop)로 넘어가지 않게
    setOver(false);
    if (draggingOut.current) return;
    // 폴더는 읽을 내용이 없는 빈 파일로 들어온다. 뺀다.
    const files = Array.from(e.dataTransfer.items)
      .filter((item) => item.kind === "file" && !item.webkitGetAsEntry()?.isDirectory)
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    for (const file of files) await shelfApi.add(file).catch(console.warn);
    refresh();
  }

  function dragOut(e: React.DragEvent, item: ShelfItem) {
    e.preventDefault(); // HTML 드래그 대신 macOS 드래그로 파일을 넘긴다
    draggingOut.current = true;
    startDrag({ item: [item.path], icon: shelfDragIcon() }, () => {
      draggingOut.current = false;
    }).catch((err) => {
      draggingOut.current = false;
      console.warn("startDrag failed:", err);
    });
  }

  async function remove(name: string) {
    await shelfApi.remove(name).catch(console.warn);
    refresh();
  }

  return (
    <div
      className={`memo-half shelf ${over ? "shelf--over" : ""}`}
      data-shelf
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        if (!draggingOut.current) setOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false);
      }}
      onDrop={onDrop}
    >
      <div className="panel-card__header">
        <span className="draw-header-title"><Archive size={10} strokeWidth={2} /> 임시 보관함</span>
        {items.length > 0 && <span className="shelf__count">{items.length}</span>}
      </div>
      <div className="panel-card__body shelf__body">
        {items.length === 0 ? (
          <span className="panel-empty">파일을 끌어다 놓기</span>
        ) : (
          <ul className="shelf__list">
            {items.map((item) => (
              <li
                key={item.name}
                className="shelf__item"
                draggable
                onDragStart={(e) => dragOut(e, item)}
                title={`${item.name} — 끌어서 다른 곳에 놓기`}
              >
                <FileText size={11} strokeWidth={2} className="shelf__icon" />
                <span className="shelf__name">{item.name}</span>
                <span className="shelf__size">{formatBytes(item.size)}</span>
                <button className="shelf__remove" onClick={() => remove(item.name)} title="보관함에서 지우기">
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Right Panel ───────────────────────────────────────────────────────────────

export function RightPanel({
  onResizeStart,
  isResizing,
}: {
  onResizeStart?: (e: React.MouseEvent) => void;
  isResizing?: boolean;
}) {
  // 자리가 모자라면(메모가 정사각형을 못 지키면) 포모도로를 한 줄로 접는다. 펴는 건
  // 메모 위 빈칸이 펼친 만큼 생겼을 때만 — 접고 펴는 기준이 같으면 경계에서 깜빡인다.
  const ref = useRef<HTMLElement>(null);
  const [tight, setTight] = useState(false);
  const tightRef = useRef(false);
  const fullPomoH = useRef(0);

  useEffect(() => {
    const panel = ref.current;
    if (!panel) return;
    const check = () => {
      const memo = panel.querySelector<HTMLElement>(".panel-card--memo");
      const pomo = panel.querySelector<HTMLElement>(".pomo-body");
      if (!memo || !pomo) return;
      const squeezed = memo.offsetHeight < memo.offsetWidth - 1 || panel.scrollHeight > panel.clientHeight;
      let next: boolean;
      if (!tightRef.current) {
        fullPomoH.current = pomo.offsetHeight;
        next = squeezed;
      } else {
        const prev = memo.previousElementSibling as HTMLElement;
        const gap = memo.offsetTop - (prev.offsetTop + prev.offsetHeight);
        next = squeezed || gap < fullPomoH.current - pomo.offsetHeight;
      }
      tightRef.current = next;
      setTight(next);
    };
    // 카드 높이(할 일 추가, 아코디언, 일정)가 바뀌어도 다시 잰다.
    const ro = new ResizeObserver(check);
    ro.observe(panel);
    Array.from(panel.children).forEach((c) => ro.observe(c));
    return () => ro.disconnect();
  }, []);

  return (
    <aside ref={ref} className={`right-panel ${tight ? "right-panel--tight" : ""}`}>
      {onResizeStart && (
        <div
          className={`right-panel__resize-handle ${isResizing ? "right-panel__resize-handle--dragging" : ""}`}
          onMouseDown={onResizeStart}
        />
      )}
      <TodoCard />
      <CalendarCard />
      <PomodoroCard />
      <MemoCard />
    </aside>
  );
}

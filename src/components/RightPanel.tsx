import React, { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Pencil, Terminal } from "lucide-react";
import type { Todo, ScheduleEvent, CodeExecResult } from "../agent/types";
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

// ── TODO Card ─────────────────────────────────────────────────────────────────

function TodoCard() {
  const [todos, setTodos] = useState<Todo[]>([]);

  async function load() {
    try {
      const result = await invoke<Todo[]>("todo_list");
      setTodos(result.slice(0, 8));
    } catch {}
  }

  useEffect(() => {
    load();
    const handler = () => load();
    window.addEventListener("nekodesk:agent_done", handler);
    return () => window.removeEventListener("nekodesk:agent_done", handler);
  }, []);

  async function complete(id: number) {
    try {
      await invoke("todo_complete", { id });
      setTodos((prev) => prev.filter((t) => t.id !== id));
    } catch {}
  }

  return (
    <div className="panel-card">
      <div className="panel-card__header">✓ TODO List</div>
      <div className="panel-card__body">
        {todos.length === 0 ? (
          <span className="panel-empty">할 일 없음</span>
        ) : (
          <ul className="todo-list">
            {todos.map((t) => (
              <li
                key={t.id}
                className="todo-item"
                title={t.due_at ? `${t.content}\n기한: ${t.due_at.slice(0, 10)}` : t.content}
              >
                <button
                  className="todo-item__check"
                  onClick={() => complete(t.id)}
                  title="완료로 표시"
                >
                  ○
                </button>
                <span className="todo-item__text">{t.content}</span>
                {t.due_at && (
                  <span className="todo-item__due">{t.due_at.slice(5, 10)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Calendar Card ─────────────────────────────────────────────────────────────

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"];

function CalendarCard() {
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [events, setEvents] = useState<ScheduleEvent[]>([]);
  const [selectedDay, setSelectedDay] = useState<number | null>(today.getDate());

  async function loadEvents() {
    try {
      const result = await invoke<ScheduleEvent[]>("schedule_list", { range: "all" });
      setEvents(result);
    } catch {}
  }

  useEffect(() => {
    loadEvents();
    const handler = () => loadEvents();
    window.addEventListener("nekodesk:agent_done", handler);
    return () => window.removeEventListener("nekodesk:agent_done", handler);
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

  // Events for the displayed month
  const monthEvents = events.filter((e) => {
    const d = parseEventDate(e.start_at);
    return !isNaN(d.getTime()) && d.getFullYear() === year && d.getMonth() === month;
  });

  const eventDays = new Set(monthEvents.map((e) => parseEventDate(e.start_at).getDate()));

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
    ? monthEvents.filter((e) => parseEventDate(e.start_at).getDate() === selectedDay)
    : [];

  const isCurrentMonthView =
    year === today.getFullYear() && month === today.getMonth();

  return (
    <div className="panel-card panel-card--calendar">
      <div className="panel-card__header cal-header">
        <span>📅 캘린더</span>
        <div className="cal-nav">
          <button className="cal-nav__btn" onClick={prevMonth}>‹</button>
          <span className="cal-nav__label">{MONTH_NAMES[month]} {year}</span>
          <button className="cal-nav__btn" onClick={nextMonth}>›</button>
        </div>
      </div>
      <div className="panel-card__body">
        <div key={calKey} className={`cal-slide cal-slide--${calDir}`}>
          <div className="cal-grid">
            {DAY_LABELS.map((d) => (
              <div key={d} className="cal-cell cal-cell--label">{d}</div>
            ))}
            {cells.map((day, i) => {
              if (!day) return <div key={`_${i}`} className="cal-cell" />;
              const isToday = isCurrentMonthView && day === today.getDate();
              const hasEvent = eventDays.has(day);
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

          {selectedDay && (
            <div className="cal-events">
              {selectedEvents.length === 0 ? (
                <span className="panel-empty">{month + 1}/{selectedDay} 일정 없음</span>
              ) : (
                selectedEvents.map((e) => (
                  <div key={e.id} className="cal-event">
                    <span className="cal-event__time">
                      {e.all_day
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
  );
}

// ── Pomodoro Card ─────────────────────────────────────────────────────────────

type PomodoroMode = "focus" | "break" | "long-break";

const POMODORO_DURATIONS: Record<PomodoroMode, number> = {
  focus: 25 * 60,
  break: 5 * 60,
  "long-break": 15 * 60,
};

function formatTime(secs: number) {
  const m = Math.floor(secs / 60).toString().padStart(2, "0");
  const s = (secs % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

function PomodoroCard() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<PomodoroMode>("focus");
  const [secondsLeft, setSecondsLeft] = useState(POMODORO_DURATIONS.focus);
  const [isRunning, setIsRunning] = useState(false);
  const [sessionCount, setSessionCount] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isRunning) {
      if (intervalRef.current) clearInterval(intervalRef.current);
      return;
    }
    intervalRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(intervalRef.current!);
          setIsRunning(false);
          handleComplete();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [isRunning]);

  function handleComplete() {
    setSessionCount((prev) => {
      const next = mode === "focus" ? prev + 1 : prev;
      const nextMode: PomodoroMode =
        mode === "focus"
          ? next % 4 === 0 ? "long-break" : "break"
          : "focus";
      const msg =
        mode === "focus"
          ? `집중 완료! ${nextMode === "long-break" ? "☕ 긴 휴식 시간이에요." : "🍵 잠깐 쉬어가요."}`
          : "휴식 끝! 🐱 다시 집중해볼까요?";
      invoke("code_exec", {
        code: `display notification "${msg}" with title "NekoDesk 포모도로" sound name "Glass"`,
        language: "applescript",
      }).catch(() => {});
      setMode(nextMode);
      setSecondsLeft(POMODORO_DURATIONS[nextMode]);
      return next;
    });
  }

  function reset() {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setIsRunning(false);
    setSecondsLeft(POMODORO_DURATIONS[mode]);
  }

  const total = POMODORO_DURATIONS[mode];
  const progress = (total - secondsLeft) / total;
  const circumference = 2 * Math.PI * 28;
  const modeLabel = mode === "focus" ? "집중" : mode === "break" ? "휴식" : "긴 휴식";

  return (
    <div className="panel-card">
      <button className="panel-card__header pomo-header" onClick={() => setOpen((v) => !v)}>
        <span>⏱ 포모도로</span>
        <span className="pomo-header-right">
          {!open && <span className="pomo-header-time">{formatTime(secondsLeft)}</span>}
          <span className="pomo-session-count">{sessionCount}세션</span>
          <span className="pomo-chevron">{open ? "▲" : "▼"}</span>
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
              <div className="pomo-time">{formatTime(secondsLeft)}</div>
            </div>
            <div className="pomo-mode-label">{modeLabel}</div>
            <div className="pomo-controls">
              <button className="pomo-btn" onClick={reset} title="리셋">↺</button>
              <button className="pomo-btn pomo-btn--primary" onClick={() => setIsRunning((v) => !v)}>
                {isRunning ? "⏸" : "▶"}
              </button>
              <button
                className="pomo-btn"
                onClick={() => {
                  if (intervalRef.current) clearInterval(intervalRef.current);
                  setIsRunning(false);
                  const nextMode: PomodoroMode = mode === "focus" ? "break" : "focus";
                  setMode(nextMode);
                  setSecondsLeft(POMODORO_DURATIONS[nextMode]);
                }}
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

export function DrawingPadCard() {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState<"pen" | "eraser">("pen");
  const [color, setColor] = useState("#111111");
  const [thick, setThick] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const isDrawingRef = useRef(false);
  const lastPtRef = useRef<{ x: number; y: number } | null>(null);
  const canvasInitRef = useRef(false);

  function getCtx() {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    return canvas.getContext("2d");
  }

  // 흰색 배경 초기화 — 최초 1회만
  useEffect(() => {
    if (canvasInitRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    canvasInitRef.current = true;
  }, []);

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
    isDrawingRef.current = true;
    const pt = getPos(e);
    lastPtRef.current = pt;
    const ctx = getCtx();
    if (!ctx) return;
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
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  async function saveImage() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL("image/png");
    try {
      const savedPath = await invoke<string>("save_canvas_image", { dataUrl });
      const name = savedPath.split("/").pop() ?? "저장됨";
      setSaveMsg(`✓ ${name}`);
      window.setTimeout(() => setSaveMsg(null), 2000);
    } catch (err) {
      setSaveMsg(`✕ 저장 실패`);
      window.setTimeout(() => setSaveMsg(null), 2000);
    }
  }

  return (
    <div className="panel-card">
      <button className="panel-card__header pomo-header" onClick={() => setOpen((v) => !v)}>
        <span className="draw-header-title"><Pencil size={10} strokeWidth={2} /> 그림판</span>
        <span className="pomo-chevron">{open ? "▲" : "▼"}</span>
      </button>
      <div className={`acc-wrap ${open ? "acc-wrap--open" : ""}`}>
        <div className="acc-inner">
        <div className="panel-card__body draw-body">
          <canvas
            ref={canvasRef}
            className="draw-canvas"
            width={360}
            height={200}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}
            onMouseLeave={onMouseUp}
          />
          <div className="draw-toolbar">
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
        </div>
        </div>
      </div>
    </div>
  );
}

// ── Code Run Card ─────────────────────────────────────────────────────────────

function CodeRunCard() {
  const [result, setResult] = useState<CodeExecResult | null>(null);

  useEffect(() => {
    const handler = (e: Event) => {
      setResult((e as CustomEvent<CodeExecResult>).detail);
    };
    window.addEventListener("nekodesk:coderun", handler);
    return () => window.removeEventListener("nekodesk:coderun", handler);
  }, []);

  return (
    <div className="panel-card panel-card--bottom">
      <div className="panel-card__header"><Terminal size={10} strokeWidth={2} /> 코드 실행</div>
      <div className="panel-card__body">
        {!result ? (
          <span className="panel-empty">채팅에서 코드 실행을 요청하면<br />결과가 여기에 표시돼요</span>
        ) : (
          <div className="code-result">
            <span className={`code-result__badge ${result.exit_code === 0 ? "code-result__badge--ok" : "code-result__badge--err"}`}>
              exit {result.exit_code}
            </span>
            {result.stdout && (
              <pre className="code-result__output">{result.stdout}</pre>
            )}
            {result.stderr && (
              <pre className="code-result__output code-result__output--err">{result.stderr}</pre>
            )}
            {result.truncated && (
              <span className="panel-empty">(출력 일부 잘림)</span>
            )}
          </div>
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
  return (
    <aside className="right-panel">
      {onResizeStart && (
        <div
          className={`right-panel__resize-handle ${isResizing ? "right-panel__resize-handle--dragging" : ""}`}
          onMouseDown={onResizeStart}
        />
      )}
      <TodoCard />
      <CalendarCard />
      <PomodoroCard />
      <CodeRunCard />
    </aside>
  );
}

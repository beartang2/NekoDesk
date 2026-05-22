import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Todo, ScheduleEvent, CodeExecResult } from "../agent/types";
import "./RightPanel.css";

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
              <li key={t.id} className="todo-item">
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
const DAY_LABELS = ["월", "화", "수", "목", "금", "토", "일"];

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

  function prevMonth() {
    if (month === 0) { setYear((y) => y - 1); setMonth(11); }
    else setMonth((m) => m - 1);
    setSelectedDay(null);
  }

  function nextMonth() {
    if (month === 11) { setYear((y) => y + 1); setMonth(0); }
    else setMonth((m) => m + 1);
    setSelectedDay(null);
  }

  // Events for the displayed month
  const monthEvents = events.filter((e) => {
    const d = new Date(e.start_at);
    return d.getFullYear() === year && d.getMonth() === month;
  });

  const eventDays = new Set(monthEvents.map((e) => new Date(e.start_at).getDate()));

  // Calendar grid (Mon-first)
  const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0=Sun
  const startOffset = (firstDayOfWeek + 6) % 7; // 0=Mon
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  const cells: (number | null)[] = [
    ...Array(startOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const selectedEvents = selectedDay
    ? monthEvents.filter((e) => new Date(e.start_at).getDate() === selectedDay)
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
                      : new Date(e.start_at).toLocaleTimeString("ko-KR", {
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
    <div className="panel-card">
      <div className="panel-card__header">⌨ 코드 실행</div>
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

export function RightPanel() {
  return (
    <aside className="right-panel">
      <TodoCard />
      <CalendarCard />
      <CodeRunCard />
    </aside>
  );
}

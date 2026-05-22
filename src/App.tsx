import React, { useRef, useEffect, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sun, Moon, Settings, Paperclip } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { AgentStepAccordion } from "./components/AgentStepAccordion";
import { CatCanvas } from "./cat/CatCanvas";
import { CatStatusPanel } from "./components/CatStatusPanel";
import { SettingsModal } from "./components/SettingsModal";
import { RightPanel } from "./components/RightPanel";
import { useAgentPool, makeInitialMessages } from "./hooks/useAgentLoop";
import { useCatRpg } from "./hooks/useCatRpg";
import { initMcpFromStorage } from "./agent/mcp-registry";
import { storeFile, removeFile } from "./agent/file-store";
import { applyThemeColors } from "./theme-colors";
import type { ChatMessage, AttachedFile, PendingConfirm } from "./hooks/useAgentLoop";
import type { CatEmotion, LlmMessage } from "./agent/types";
import { compactMessages } from "./agent/llm-client";
import "./App.css";

interface ConversationMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

// ── Session types ─────────────────────────────────────────────────────────────

const SLEEPY_AFTER_MS = 5 * 60 * 1000;
const SESSIONS_KEY = "nekodesk_sessions";
const ACTIVE_SESSION_KEY = "nekodesk_active_session";

interface Session {
  id: string;
  title: string;
  date: string;
}

function makeSession(): Session {
  return {
    id: crypto.randomUUID(),
    title: "새 대화",
    date: "방금",
  };
}

function restoreState(): { sessions: Session[]; activeId: string } {
  let sessions: Session[];
  try {
    const saved = localStorage.getItem(SESSIONS_KEY);
    const parsed = saved ? (JSON.parse(saved) as Session[]) : null;
    sessions = parsed && parsed.length > 0 ? parsed : [makeSession()];
  } catch {
    sessions = [makeSession()];
  }
  const savedActiveId = localStorage.getItem(ACTIVE_SESSION_KEY);
  const activeId =
    savedActiveId && sessions.some((s) => s.id === savedActiveId)
      ? savedActiveId
      : sessions[0].id;
  return { sessions, activeId };
}

const INITIAL_STATE = restoreState();

// ── Title bar ─────────────────────────────────────────────────────────────────

const THEME_KEY = "nekodesk_theme";

function useTheme() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return saved ? saved === "dark" : true;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("light", !isDark);
    localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
    getCurrentWindow().setTheme(isDark ? "dark" : "light").catch(() => {});
    applyThemeColors(isDark);
  }, [isDark]);

  return { isDark, toggle: () => setIsDark((v) => !v) };
}

function TitleBar({
  sessionTitle,
  onSettings,
  isDark,
  onThemeToggle,
}: {
  sessionTitle: string;
  onSettings: () => void;
  isDark: boolean;
  onThemeToggle: () => void;
}) {
  return (
    <header className="titlebar">
      <span className="titlebar__name">NekoDesk</span>
      <span className="titlebar__sep">/</span>
      <span className="titlebar__session">{sessionTitle}</span>
      <button className="titlebar__settings" onClick={onThemeToggle} title={isDark ? "라이트 모드" : "다크 모드"}>
        {isDark ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <button className="titlebar__settings" onClick={onSettings} title="설정">
        <Settings size={14} />
      </button>
    </header>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────

function Sidebar({
  sessions,
  activeId,
  onSelect,
  onNew,
  onDelete,
  emotion,
  rpg,
}: {
  sessions: Session[];
  activeId: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  emotion: CatEmotion;
  rpg: {
    dayCount: number;
    hunger: number;
    play: number;
    canFeed: boolean;
    feedCountToday: number;
    isCompacting: boolean;
    onFeed: () => void;
    onPlay: () => void;
    onPet: () => void;
  };
}) {
  return (
    <aside className="sidebar">
      <button className="sidebar__new-btn" onClick={onNew}>
        ＋ 새 대화
      </button>

      <span className="sidebar__section-label">최근</span>
      <div className="sidebar__list">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeId ? "session-item--active" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <span className="session-item__title">{s.title}</span>
            <span className="session-item__date">{s.date}</span>
            <button
              className="session-item__delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(s.id);
              }}
              title="삭제"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="cat-panel">
        <CatCanvas emotion={emotion} onPet={rpg.onPet} />
        <CatStatusPanel
          dayCount={rpg.dayCount}
          hunger={rpg.hunger}
          play={rpg.play}
          canFeed={rpg.canFeed}
          feedCountToday={rpg.feedCountToday}
          isCompacting={rpg.isCompacting}
          onFeed={rpg.onFeed}
          onPlay={rpg.onPlay}
        />
      </div>
    </aside>
  );
}

// ── Chat messages ─────────────────────────────────────────────────────────────

function ChatMessages({
  messages,
  isRunning,
}: {
  messages: ChatMessage[];
  isRunning: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="chat-messages">
      {messages.map((m) => (
        <div key={m.id} className={`message message--${m.role}`}>
          {m.role === "assistant" && m.steps && m.steps.length > 0 && (
            <AgentStepAccordion
              steps={m.steps}
              isRunning={isRunning && !!m.isStreaming}
            />
          )}

          {(m.content || m.isStreaming || (m.attachments && m.attachments.length > 0)) && (
            <div className="message__bubble">
              {m.content && (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
              )}
              {m.attachments && m.attachments.length > 0 && (
                <div className="message__attachments">
                  {m.attachments.map((f, i) => (
                    <span key={i} className="message__file-chip">
                      <Paperclip size={10} style={{ flexShrink: 0 }} />
                      {f.name}
                    </span>
                  ))}
                </div>
              )}
              {m.isStreaming && <span className="message__cursor" />}
            </div>
          )}

          <span className="message__meta">{m.time}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

// ── Composer helpers ──────────────────────────────────────────────────────────

function isTextFile(file: File): boolean {
  return (
    file.type.startsWith("text/") ||
    /\.(js|ts|tsx|jsx|json|md|markdown|yaml|yml|toml|rs|py|go|java|c|cpp|h|css|html|xml|sh|bash|zsh|fish|env|gitignore|log|csv|sql|txt)$/i.test(file.name)
  );
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve((e.target?.result as string) ?? "");
    reader.onerror = () => resolve("");
    reader.readAsText(file);
  });
}

// ── Composer ──────────────────────────────────────────────────────────────────

function Composer({
  onSend,
  onStop,
  onActivity,
  isRunning,
}: {
  onSend: (text: string, files: AttachedFile[]) => void;
  onStop: () => void;
  onActivity: () => void;
  isRunning: boolean;
}) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function submit() {
    const text = value.trim();
    if ((!text && files.length === 0) || isRunning) return;
    onActivity();
    onSend(text, files);
    setValue("");
    setFiles([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onActivity();
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = "";
    // Store raw File objects so the file.upload tool can access them
    for (const file of selected) {
      storeFile(file);
    }
    const newFiles = await Promise.all(
      selected.map(async (file): Promise<AttachedFile> => {
        const content = isTextFile(file) ? await readFileAsText(file) : "";
        return { name: file.name, content, size: file.size, type: file.type };
      })
    );
    setFiles((prev) => [...prev, ...newFiles]);
  }

  function removeAttachedFile(index: number) {
    setFiles((prev) => {
      const removed = prev[index];
      if (removed) removeFile(removed.name);
      return prev.filter((_, i) => i !== index);
    });
  }

  return (
    <div className="composer">
      {files.length > 0 && (
        <div className="composer__files">
          {files.map((f, i) => (
            <div key={i} className="file-chip">
              <Paperclip size={10} style={{ flexShrink: 0, color: "var(--accent)" }} />
              <span className="file-chip__name">{f.name}</span>
              <button
                className="file-chip__remove"
                onClick={() => removeAttachedFile(i)}
                title="제거"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer__row">
        <textarea
          ref={textareaRef}
          className="composer__input"
          placeholder="메시지 입력… (Shift+Enter로 줄바꿈)"
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onFocus={onActivity}
          rows={1}
          disabled={isRunning}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        <button
          className="composer__attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={isRunning}
          title="파일 첨부"
        >
          <Paperclip size={14} />
        </button>
        {isRunning ? (
          <button className="composer__stop" onClick={onStop}>
            ■ 중단
          </button>
        ) : (
          <button
            className="composer__send"
            onClick={submit}
            disabled={!value.trim() && files.length === 0}
          >
            전송
          </button>
        )}
      </div>
    </div>
  );
}

// ── Confirm banner ────────────────────────────────────────────────────────────

function ConfirmBanner({ confirm, onResolve }: { confirm: PendingConfirm; onResolve: (ok: boolean) => void }) {
  return (
    <div className={`confirm-banner ${confirm.isDangerous ? "confirm-banner--danger" : ""}`}>
      <div className="confirm-banner__header">
        <span className="confirm-banner__tag">{confirm.language}</span>
        {confirm.isDangerous && (
          <span className="confirm-banner__warn">⚠ {confirm.dangerReason}</span>
        )}
      </div>
      <pre className="confirm-banner__code">{confirm.code}</pre>
      <div className="confirm-banner__actions">
        <button className="confirm-banner__deny" onClick={() => onResolve(false)}>Deny</button>
        <button className={`confirm-banner__allow ${confirm.isDangerous ? "confirm-banner__allow--danger" : ""}`} onClick={() => onResolve(true)}>Allow</button>
      </div>
    </div>
  );
}

// ── Error banner ──────────────────────────────────────────────────────────────

function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div className="error-banner">
      <span>{message}</span>
      <button className="error-banner__close" onClick={onDismiss}>
        ✕
      </button>
    </div>
  );
}

// ── Compact summary bar ───────────────────────────────────────────────────────

function CompactSummaryBar({
  summary,
  expanded,
  onToggle,
}: {
  summary: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`compact-tab ${expanded ? "compact-tab--open" : ""}`}>
      <button className="compact-tab__btn" onClick={onToggle} title="이전 대화 요약">
        <span className="compact-tab__icon">📦</span>
        <span className="compact-tab__chevron">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="compact-tab__panel">
          <div className="compact-tab__panel-inner">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Session list ──────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState<Session[]>(INITIAL_STATE.sessions);
  const [activeId, setActiveId] = useState<string>(INITIAL_STATE.activeId);

  // ── Per-session messages: Record<sessionId, ChatMessage[]> ────────────────
  const [allMessages, setAllMessages] = useState<Record<string, ChatMessage[]>>(
    () => Object.fromEntries(INITIAL_STATE.sessions.map((s) => [s.id, makeInitialMessages()]))
  );

  // ── Per-session compact summaries (상단 접이식 요약 바) ──────────────────────
  const [compactSummaries, setCompactSummaries] = useState<Record<string, string>>(() => {
    const result: Record<string, string> = {};
    INITIAL_STATE.sessions.forEach((s) => {
      const saved = localStorage.getItem(`nekodesk_compact_${s.id}`);
      if (saved) result[s.id] = saved;
    });
    return result;
  });
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  // Track which sessions have had messages loaded from DB
  const loadedSessionsRef = useRef<Set<string>>(new Set());

  async function loadSessionMessages(sessionId: string) {
    if (loadedSessionsRef.current.has(sessionId)) return;
    loadedSessionsRef.current.add(sessionId);
    try {
      const msgs = await invoke<ConversationMessage[]>("conversation_load", { sessionId });
      if (msgs.length === 0) return;
      const chatMessages: ChatMessage[] = msgs.map((m) => ({
        id: crypto.randomUUID(),
        role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
        content: m.content,
        time: new Date(m.created_at).toLocaleTimeString("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
        }),
        steps: [],
        isStreaming: false,
      }));
      setAllMessages((prev) => ({ ...prev, [sessionId]: chatMessages }));
    } catch {
      // ignore — DB may be empty for this session
    }
  }

  // Active session's messages
  const activeMessages = allMessages[activeId] ?? [];

  // Ref so the pool's async loops always read the latest allMessages
  const allMessagesRef = useRef(allMessages);
  allMessagesRef.current = allMessages;

  // ── Agent pool (parallel per-session processing) ──────────────────────
  const pool = useAgentPool(allMessagesRef, setAllMessages);
  const { state: rpgState, dayCount, canFeed, feed, playAction, pet, reward, consume } = useCatRpg();

  const isRunning = pool.isRunning(activeId);
  const catEmotion = pool.catEmotion(activeId);
  const error = pool.error(activeId);
  const [lastUserActivityAt, setLastUserActivityAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());

  const markUserActivity = useCallback(() => {
    const timestamp = Date.now();
    setLastUserActivityAt(timestamp);
    setNow(timestamp);
  }, []);

  // 에이전트 루프 완료 시 play +5
  const prevIsRunning = useRef(isRunning);
  useEffect(() => {
    if (prevIsRunning.current && !isRunning) {
      reward(5);
    }
    prevIsRunning.current = isRunning;
  }, [isRunning, reward]);

  useEffect(() => {
    if (isRunning) {
      setNow(Date.now());
      return;
    }

    const id = window.setInterval(() => {
      setNow(Date.now());
    }, 30000);

    return () => window.clearInterval(id);
  }, [isRunning]);

  const [isBoxMode, setIsBoxMode] = useState(false);
  const [actionEmotion, setActionEmotion] = useState<CatEmotion | null>(null);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerActionEmotion = useCallback((emotion: CatEmotion, durationMs = 2500) => {
    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    setActionEmotion(emotion);
    actionTimerRef.current = setTimeout(() => {
      setActionEmotion(null);
      actionTimerRef.current = null;
    }, durationMs);
  }, []);

  // play >= 80이면 랜덤으로 box 상태 진입 (30~120초 간격)
  useEffect(() => {
    if (isRunning || rpgState.play < 80) {
      setIsBoxMode(false);
      return;
    }
    const delay = 30_000 + Math.random() * 90_000;
    const id = window.setTimeout(() => setIsBoxMode(true), delay);
    return () => window.clearTimeout(id);
  }, [isRunning, rpgState.play]);

  // box 상태는 60초 후 자동 해제
  useEffect(() => {
    if (!isBoxMode) return;
    const id = window.setTimeout(() => setIsBoxMode(false), 60_000);
    return () => window.clearTimeout(id);
  }, [isBoxMode]);

  // ── 컨텍스트 크기 → 배고픔 압력 ─────────────────────────────────────────────
  // 대화가 길어질수록 hunger 표시값이 낮아진다 (최대 -40pt 압력)
  const MAX_CONTEXT_CHARS = 20_000;
  const contextChars = (allMessages[activeId] ?? []).reduce(
    (sum, m) => sum + m.content.length,
    0
  );
  const contextPressure = Math.min(1, contextChars / MAX_CONTEXT_CHARS);
  const displayHunger = Math.max(0, rpgState.hunger - Math.round(contextPressure * 40));

  const isGaugeSleepy = displayHunger < 30 || rpgState.play < 20;
  const displayEmotion: CatEmotion =
    !isRunning && actionEmotion
      ? actionEmotion
      : !isRunning && (now - lastUserActivityAt >= SLEEPY_AFTER_MS || isGaugeSleepy)
      ? "sleepy"
      : isBoxMode && !isRunning
      ? "cozy"
      : catEmotion;

  // ── 밥 주기 = 컨텍스트 compact ───────────────────────────────────────────────
  const [isCompacting, setIsCompacting] = useState(false);

  const handleFeed = useCallback(async () => {
    if (isCompacting) return;

    const msgs = (allMessages[activeId] ?? []).filter(
      (m) => m.role === "user" || m.role === "assistant"
    );

    if (msgs.length < 2) {
      // 요약할 대화 없음 → 그냥 hunger 회복
      feed();
      triggerActionEmotion("proud");
      return;
    }

    setIsCompacting(true);
    try {
      const llmMessages: LlmMessage[] = msgs.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const summary = await compactMessages(llmMessages);

      // 요약은 챗버블이 아닌 상단 요약 바에 표시
      setCompactSummaries((prev) => ({ ...prev, [activeId]: summary }));
      localStorage.setItem(`nekodesk_compact_${activeId}`, summary);
      setSummaryExpanded(false);

      // 대화 메시지는 초기화 (새 시작)
      setAllMessages((prev) => ({ ...prev, [activeId]: makeInitialMessages() }));
      loadedSessionsRef.current.delete(activeId); // 재로드 방지

      // DB 초기화
      await invoke("conversation_delete", { sessionId: activeId });

      feed();
      triggerActionEmotion("proud");
    } catch {
      // compact 실패해도 무음 처리
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, allMessages, activeId, feed, triggerActionEmotion, setAllMessages, setCompactSummaries, setSummaryExpanded]);

  const handleSend = useCallback((text: string, files: AttachedFile[]) => {
    markUserActivity();
    consume();
    void pool.sendMessage(activeId, text, files);
  }, [markUserActivity, consume, pool, activeId]);

  // ── Persist sessions & activeId to localStorage ───────────────────────────
  useEffect(() => {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }, [sessions]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_SESSION_KEY, activeId);
  }, [activeId]);

  // ── Load messages for active session on mount & on session switch ─────────
  useEffect(() => {
    void loadSessionMessages(activeId);
    setSummaryExpanded(false); // 세션 전환 시 요약 접힘
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ── Auto-title: use first user message as session title ───────────────────
  useEffect(() => {
    const firstUser = activeMessages.find((m) => m.role === "user");
    if (!firstUser) return;
    setSessions((prev) =>
      prev.map((s) =>
        s.id === activeId && s.title === "새 대화"
          ? { ...s, title: firstUser.content.slice(0, 24) }
          : s
      )
    );
  }, [activeMessages, activeId]);

  // ── New session ───────────────────────────────────────────────────────────
  function handleNew() {
    const session = makeSession();
    setSessions((prev) => [session, ...prev]);
    setAllMessages((prev) => ({ ...prev, [session.id]: makeInitialMessages() }));
    setActiveId(session.id);
  }

  // ── Delete session ────────────────────────────────────────────────────────
  function handleDelete(id: string) {
    // Remove from DB, loaded cache, and compact summary
    invoke("conversation_delete", { sessionId: id }).catch(() => {});
    loadedSessionsRef.current.delete(id);
    localStorage.removeItem(`nekodesk_compact_${id}`);
    setCompactSummaries((prev) => { const { [id]: _, ...rest } = prev; return rest; });

    const remaining = sessions.filter((s) => s.id !== id);

    if (remaining.length === 0) {
      // Last session deleted → create a fresh replacement
      const fresh = makeSession();
      setSessions([fresh]);
      setAllMessages((prev) => {
        const { [id]: _, ...rest } = prev;
        return { ...rest, [fresh.id]: makeInitialMessages() };
      });
      setActiveId(fresh.id);
      return;
    }

    setSessions(remaining);
    setAllMessages((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (id === activeId) {
      setActiveId(remaining[0].id);
    }
  }

  // Init MCP servers on mount
  useEffect(() => { initMcpFromStorage(); }, []);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const { isDark, toggle: toggleTheme } = useTheme();
  const activeSession = sessions.find((s) => s.id === activeId);

  return (
    <div className="app">
      <TitleBar
        sessionTitle={activeSession?.title ?? ""}
        onSettings={() => setSettingsOpen(true)}
        isDark={isDark}
        onThemeToggle={toggleTheme}
      />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} isDark={isDark} />}

      <Sidebar
        sessions={sessions}
        activeId={activeId}
        onSelect={setActiveId}
        onNew={handleNew}
        onDelete={handleDelete}
        emotion={displayEmotion}
        rpg={{
          dayCount,
          hunger: displayHunger,
          play: rpgState.play,
          canFeed,
          feedCountToday: rpgState.feedCountToday,
          isCompacting,
          onFeed: () => { void handleFeed(); },
          onPlay: () => { playAction(); triggerActionEmotion("happy"); },
          onPet: () => { pet(); setIsBoxMode(false); },
        }}
      />

      <main className="main">
        {error && (
          <ErrorBanner message={error} onDismiss={() => {}} />
        )}

        <div className="chat-area">
          {compactSummaries[activeId] && (
            <CompactSummaryBar
              summary={compactSummaries[activeId]}
              expanded={summaryExpanded}
              onToggle={() => setSummaryExpanded((v) => !v)}
            />
          )}

          <ChatMessages messages={activeMessages} isRunning={isRunning} />
        </div>

        {pool.pendingConfirm && pool.pendingConfirm.sessionId === activeId && (
          <ConfirmBanner confirm={pool.pendingConfirm} onResolve={pool.confirmResolve} />
        )}

        <Composer
          onSend={handleSend}
          onStop={() => pool.stop(activeId)}
          onActivity={markUserActivity}
          isRunning={isRunning}
        />
      </main>

      <RightPanel />
    </div>
  );
}

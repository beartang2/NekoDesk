import React, { useRef, useEffect, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sun, Moon, Settings, Paperclip, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AgentStepAccordion } from "./components/AgentStepAccordion";
import { CatCanvas } from "./cat/CatCanvas";
import { CAT_VARIANTS, DEFAULT_VARIANT_ID, getCatVariant } from "./cat/spriteData";
import { CatStatusPanel } from "./components/CatStatusPanel";
import { SettingsModal } from "./components/SettingsModal";
import { RightPanel } from "./components/RightPanel";
import { useAgentPool, makeInitialMessages } from "./hooks/useAgentLoop";
import { useCatRpg } from "./hooks/useCatRpg";
import { initMcpFromStorage } from "./agent/mcp-registry";
import { storeFile, removeFile } from "./agent/file-store";
import { applyThemeColors } from "./theme-colors";
import type { ChatMessage, AttachedFile, PendingConfirm, PendingClarify } from "./hooks/useAgentLoop";
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
    return saved ? saved === "dark" : false;
  });

  useEffect(() => {
    document.documentElement.classList.toggle("light", !isDark);
    localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
    getCurrentWindow().setTheme(isDark ? "dark" : "light").catch(() => {});
    applyThemeColors(isDark);
  }, [isDark]);

  return { isDark, toggle: () => setIsDark((v) => !v) };
}

// ── Zoom ──────────────────────────────────────────────────────────────────────

const ZOOM_KEY = "nekodesk_zoom";
const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;

function applyZoom(factor: number) {
  document.documentElement.style.zoom = String(factor);
  localStorage.setItem(ZOOM_KEY, String(factor));
}

function useZoom() {
  const zoomRef = useRef<number>(1);

  useEffect(() => {
    const saved = parseFloat(localStorage.getItem(ZOOM_KEY) ?? "1");
    const initial = isNaN(saved) ? 1 : saved;
    zoomRef.current = initial;
    applyZoom(initial);

    function onKeyDown(e: KeyboardEvent) {
      if (!e.metaKey) return;
      const cur = zoomRef.current;
      let next: number | null = null;
      if (e.key === "=" || e.key === "+") next = Math.min(ZOOM_MAX, Math.round((cur + ZOOM_STEP) * 10) / 10);
      else if (e.key === "-")             next = Math.max(ZOOM_MIN, Math.round((cur - ZOOM_STEP) * 10) / 10);
      else if (e.key === "0")             next = 1;
      if (next === null) return;
      e.preventDefault();
      zoomRef.current = next;
      applyZoom(next);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

function TitleBar({
  sessionTitle,
  onSettings,
  isDark,
  onThemeToggle,
  rightPanelVisible,
  onToggleRightPanel,
}: {
  sessionTitle: string;
  onSettings: () => void;
  isDark: boolean;
  onThemeToggle: () => void;
  rightPanelVisible: boolean;
  onToggleRightPanel: () => void;
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
      <button
        className={`titlebar__panel-toggle ${rightPanelVisible ? "titlebar__panel-toggle--active" : ""}`}
        onClick={onToggleRightPanel}
        title={rightPanelVisible ? "오른쪽 패널 접기" : "오른쪽 패널 펼치기"}
      >
        {rightPanelVisible ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
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
  onResizeStart,
  isResizing,
  catVariantId,
  contextTokens,
  petSignal,
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
  onResizeStart?: (e: React.MouseEvent) => void;
  isResizing?: boolean;
  catVariantId: string;
  contextTokens: number;
  petSignal?: number;
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
        <div className="cat-panel__ctx">{contextTokens.toLocaleString()} / 8,192</div>
        <CatCanvas emotion={emotion} onPet={rpg.onPet} variantId={catVariantId} petSignal={petSignal} />
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
      {onResizeStart && (
        <div
          className={`sidebar__resize-handle ${isResizing ? "sidebar__resize-handle--dragging" : ""}`}
          onMouseDown={onResizeStart}
        />
      )}
    </aside>
  );
}

// ── Chat messages ─────────────────────────────────────────────────────────────

function ChatMessages({
  messages,
  isRunning,
  onScrollChange,
}: {
  messages: ChatMessage[];
  isRunning: boolean;
  onScrollChange?: (show: boolean, scrollFn: () => void) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUp = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  const scrollToBottom = useCallback(() => {
    isUserScrolledUp.current = false;
    setShowScrollBtn(false);
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  // 유저가 위로 스크롤하면 트래킹 해제
  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom > 80) {
      isUserScrolledUp.current = true;
      setShowScrollBtn(true);
    } else {
      isUserScrolledUp.current = false;
      setShowScrollBtn(false);
    }
  }, []);

  // 스크롤 버튼 상태를 부모에 전달
  useEffect(() => {
    onScrollChange?.(showScrollBtn, scrollToBottom);
  }, [showScrollBtn, scrollToBottom, onScrollChange]);

  // 메시지 변경 시 트래킹 중이면 스크롤다운
  useEffect(() => {
    if (!isUserScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  return (
    <div className="chat-messages" ref={containerRef} onScroll={handleScroll}>
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
              {m.role === "assistant" && m.content && !m.isStreaming && (
                <CopyButton text={m.content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/\[\[PET_STATE:\w+\]\]/g, "").trim()} />
              )}
              {m.content && (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    table: ({ children }) => (
                      <div className="table-wrapper"><table>{children}</table></div>
                    ),
                  }}
                >
                  {m.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()}
                </ReactMarkdown>
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

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button className="message__copy" onClick={copy}>
      {copied ? "복사됨" : "복사"}
    </button>
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

// ── Clarify banner ────────────────────────────────────────────────────────────

function ClarifyBanner({ clarify, onAnswer }: { clarify: PendingClarify; onAnswer: (answer: string) => void }) {
  return (
    <div className="clarify-banner">
      <p className="clarify-banner__q">🐱 {clarify.question}</p>
      <div className="clarify-banner__opts">
        {clarify.options.map((opt) => (
          <button key={opt} className="clarify-banner__opt" onClick={() => onAnswer(opt)}>
            {opt}
          </button>
        ))}
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
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {summary.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()}
            </ReactMarkdown>
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

  // ── Cat variant ───────────────────────────────────────────────────────────
  const VARIANT_STORAGE_KEY = "nekodesk_cat_variant";
  const [catVariantId, setCatVariantId] = useState<string>(
    () => getCatVariant(localStorage.getItem(VARIANT_STORAGE_KEY) ?? DEFAULT_VARIANT_ID).id
  );
  function handleVariantChange(id: string) {
    setCatVariantId(id);
    localStorage.setItem(VARIANT_STORAGE_KEY, id);
  }

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
  const { state: rpgState, dayCount, canFeed, feed, playAction, pet, reward, consume } = useCatRpg(activeId);

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
  const [petSignal, setPetSignal] = useState(0);
  const boxPetCountRef = useRef(0);
  const BOX_EXIT_PET_COUNT = 3;
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

  // 가속도 센서 탭 → 쓰다듬기 (맥북 트랙패드 양 옆 톡톡)
  const isBoxModeRef = useRef(isBoxMode);
  isBoxModeRef.current = isBoxMode;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen("nekodesk:pet", () => {
      pet();
      setPetSignal((n) => n + 1);
      if (isBoxModeRef.current) {
        boxPetCountRef.current += 1;
        if (boxPetCountRef.current >= BOX_EXIT_PET_COUNT) {
          boxPetCountRef.current = 0;
          setIsBoxMode(false);
        }
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [pet]);

  // play >= 80이면 랜덤으로 box 상태 진입 (30~120초 간격)
  useEffect(() => {
    if (isRunning || rpgState.play < 80) {
      setIsBoxMode(false);
      return;
    }
    const delay = 30_000 + Math.random() * 90_000;
    const id = window.setTimeout(() => { boxPetCountRef.current = 0; setIsBoxMode(true); }, delay);
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
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  const scrollToBottomRef = useRef<() => void>(() => {});
  const handleScrollChange = useCallback((show: boolean, scrollFn: () => void) => {
    setShowScrollBtn(show);
    scrollToBottomRef.current = scrollFn;
  }, []);
  const { isDark, toggle: toggleTheme } = useTheme();
  useZoom();
  const activeSession = sessions.find((s) => s.id === activeId);

  // ── Panel visibility & resize ─────────────────────────────────────────────
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [rightPanelVisible, setRightPanelVisible] = useState(true);
  const [sidebarW, setSidebarW] = useState(220);
  const [rightPanelW, setRightPanelW] = useState(210);

  const dragRef = useRef<{
    type: "sidebar" | "right";
    startX: number;
    startW: number;
  } | null>(null);
  const [isDragging, setIsDragging] = useState<"sidebar" | "right" | null>(null);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const { type, startX, startW } = dragRef.current;
      const delta = e.clientX - startX;
      if (type === "sidebar") {
        setSidebarW(Math.max(160, Math.min(400, startW + delta)));
      } else {
        setRightPanelW(Math.max(160, Math.min(400, startW - delta)));
      }
    }
    function onMouseUp() {
      dragRef.current = null;
      setIsDragging(null);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  function startDrag(type: "sidebar" | "right", e: React.MouseEvent) {
    e.preventDefault();
    const startW = type === "sidebar" ? sidebarW : rightPanelW;
    dragRef.current = { type, startX: e.clientX, startW };
    setIsDragging(type);
  }

  const appStyle = {
    "--sidebar-w": sidebarVisible ? `${sidebarW}px` : "0px",
    "--right-panel-w": rightPanelVisible ? `${rightPanelW}px` : "0px",
  } as React.CSSProperties;

  return (
    <div className={`app${isDragging ? " app--resizing" : ""}`} style={appStyle}>
      <TitleBar
        sessionTitle={activeSession?.title ?? ""}
        onSettings={() => setSettingsOpen(true)}
        isDark={isDark}
        onThemeToggle={toggleTheme}
        rightPanelVisible={rightPanelVisible}
        onToggleRightPanel={() => setRightPanelVisible((v) => !v)}
      />
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} isDark={isDark} catVariantId={catVariantId} onCatVariantChange={handleVariantChange} />}

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
          onPet: () => {
            pet();
            if (isBoxMode) {
              boxPetCountRef.current += 1;
              if (boxPetCountRef.current >= BOX_EXIT_PET_COUNT) {
                boxPetCountRef.current = 0;
                setIsBoxMode(false);
              }
            }
          },
        }}
        onResizeStart={sidebarVisible ? (e) => startDrag("sidebar", e) : undefined}
        isResizing={isDragging === "sidebar"}
        catVariantId={catVariantId}
        contextTokens={Math.round(
          activeMessages.reduce((sum, m) => sum + m.content.length, 0) / 3.5
        )}
        petSignal={petSignal}
      />

      <main className="main">
        {error && (
          <ErrorBanner message={error} onDismiss={() => pool.clearError(activeId)} />
        )}

        <div className="chat-area">
          {compactSummaries[activeId] && (
            <CompactSummaryBar
              summary={compactSummaries[activeId]}
              expanded={summaryExpanded}
              onToggle={() => setSummaryExpanded((v) => !v)}
            />
          )}

          <ChatMessages messages={activeMessages} isRunning={isRunning} onScrollChange={handleScrollChange} />
        </div>

        {pool.pendingConfirm && pool.pendingConfirm.sessionId === activeId && (
          <ConfirmBanner confirm={pool.pendingConfirm} onResolve={pool.confirmResolve} />
        )}

        {pool.pendingClarify && pool.pendingClarify.sessionId === activeId && (
          <ClarifyBanner clarify={pool.pendingClarify} onAnswer={pool.clarifyResolve} />
        )}

        {showScrollBtn && (
          <button
            className="chat-scroll-btn"
            onClick={() => scrollToBottomRef.current()}
            title="맨 아래로"
          >
            ↓
          </button>
        )}

        <Composer
          onSend={handleSend}
          onStop={() => pool.stop(activeId)}
          onActivity={markUserActivity}
          isRunning={isRunning}
        />
      </main>

      <RightPanel
        onResizeStart={rightPanelVisible ? (e) => startDrag("right", e) : undefined}
        isResizing={isDragging === "right"}
      />
    </div>
  );
}

import React, { useRef, useEffect, useState, useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sun, Moon, Settings, Paperclip, ArrowUp, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { AgentStepAccordion } from "./components/AgentStepAccordion";
import { PlanChecklist } from "./components/PlanChecklist";
import { ChatEmptyState } from "./components/ChatEmptyState";
import { CatCanvas } from "./cat/CatCanvas";
import { CatStatusPanel } from "./components/CatStatusPanel";
import { RightPanel, DrawingPadCard, parseEventDate } from "./components/RightPanel";
import { MenuModal } from "./components/MenuModal";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { useDrawingGame } from "./hooks/useDrawingGame";
import { useWordChainGame } from "./hooks/useWordChainGame";
import { useAgentPool, makeInitialMessages } from "./hooks/useAgentLoop";
import { useMessageStore } from "./stores/messageStore";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { useCatRpg } from "./hooks/useCatRpg";
import { todosApi, scheduleApi, settingsApi, conversationApi } from "./api/tauri";
import { appEvents, resolveWordchainFirstWord } from "./lib/events";
import { useSessionStore, makeSession, type Session } from "./stores/sessionStore";
import { useLayout } from "./hooks/useLayout";
import { initMcpFromStorage } from "./agent/mcp-registry";
import { loadPermissionRules } from "./agent/permissions";
import { reloadUserSkills } from "./agent/knowledge";
import { detectGameIntent } from "./lib/game-intent";
import { roParticle } from "./lib/hangul";
import { storeFile, removeFile } from "./agent/file-store";
import { applyThemeColors } from "./theme-colors";
import type { ChatMessage, AttachedFile, PendingConfirm, PendingClarify } from "./hooks/useAgentLoop";
import type {
  CatEmotion,
  LlmMessage,
  PermissionDecision,
  ScheduleEvent,
  Todo,
} from "./agent/types";
import { compactMessages, fetchLoadedModel } from "./agent/llm-client";
import { activateProfile, loadProfiles, probe, profileUrl } from "./stores/modelProfiles";
import "./App.css";

// ── Session types ─────────────────────────────────────────────────────────────

const SLEEPY_AFTER_MS = 5 * 60 * 1000;

// 세션 상태는 sessionStore 가 소유한다(Session/makeSession 도 거기서 재노출).

// ── Title bar ─────────────────────────────────────────────────────────────────

const THEME_KEY = "nekodesk_theme";

function useTheme() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return saved ? saved === "dark" : false;
  });

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("theme-transitioning");
    root.classList.toggle("light", !isDark);
    localStorage.setItem(THEME_KEY, isDark ? "dark" : "light");
    getCurrentWindow().setTheme(isDark ? "dark" : "light").catch(() => {});
    applyThemeColors(isDark);
    const t = setTimeout(() => root.classList.remove("theme-transitioning"), 250);
    return () => clearTimeout(t);
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
    <header className="titlebar" data-tauri-drag-region="deep">
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
  onNew,
  onDelete,
  emotion,
  rpg,
  onResizeStart,
  isResizing,
  contextTokens,
  modelContextLength,
  gameSpeech,
  gameMode,
}: {
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
  contextTokens: number;
  modelContextLength: number | null;
  gameSpeech?: string | null;
  gameMode?: import("./hooks/useDrawingGame").DrawingGameState & import("./hooks/useDrawingGame").DrawingGameActions | null;
}) {
  // 세션 목록·활성·선택은 sessionStore 를 직접 구독(prop-drilling 제거).
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const onSelect = useSessionStore((s) => s.setActiveId);
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

      <DrawingPadCard gameMode={gameMode} />

      <div className="cat-panel" style={{ position: "relative" }}>
        {gameSpeech && (
          <div className="cat-game-bubble">{gameSpeech}</div>
        )}
        <div className="cat-panel__ctx">{contextTokens.toLocaleString()} / {modelContextLength != null ? modelContextLength.toLocaleString() : "--"}</div>
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
  onPickSuggestion,
}: {
  messages: ChatMessage[];
  isRunning: boolean;
  onScrollChange?: (show: boolean, scrollFn: () => void) => void;
  onPickSuggestion?: (text: string) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUp = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  /** 바닥에서 이만큼 이상 떨어져 있으면 "따라가지 않는 중" 으로 본다. */
  const BOTTOM_SLACK = 80;

  const distanceFromBottom = () => {
    const el = containerRef.current;
    return el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0;
  };

  const scrollToBottom = useCallback(() => {
    isUserScrolledUp.current = false;
    setShowScrollBtn(false);
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  /**
   * 따라갈지 말지는 **사용자 입력에서만** 바꾼다.
   *
   * `scroll` 이벤트는 사람이 굴렸든 scrollIntoView 가 움직였든 똑같이 발생한다.
   * 예전에는 그걸로 판단해서, 사용자가 위로 올려도 진행 중이던 부드러운 스크롤이
   * 바닥에 닿는 순간 "다시 바닥이네" 하고 따라가기를 되켰다 — 올려도 도로 내려가는
   * 이유가 이것이었다. wheel·touchmove 는 사람이 움직일 때만 오므로 헷갈릴 일이 없다.
   *
   * 브라우저가 스크롤을 적용한 뒤 위치를 읽어야 해서 다음 프레임에 잰다.
   */
  const handleUserScroll = useCallback(() => {
    requestAnimationFrame(() => {
      if (!containerRef.current) return;
      isUserScrolledUp.current = distanceFromBottom() > BOTTOM_SLACK;
      setShowScrollBtn(isUserScrolledUp.current);
    });
  }, []);

  /** 버튼 표시만 담당한다. 여기서 따라가기 상태를 건드리면 위 문제가 되살아난다. */
  const handleScroll = useCallback(() => {
    setShowScrollBtn(distanceFromBottom() > BOTTOM_SLACK);
  }, []);

  // 스크롤 버튼 상태를 부모에 전달
  useEffect(() => {
    onScrollChange?.(showScrollBtn, scrollToBottom);
  }, [showScrollBtn, scrollToBottom, onScrollChange]);

  // 메시지 변경 시 따라가는 중이면 바닥으로.
  //
  // 스트리밍은 토큰마다 여기를 지난다. behavior:"smooth" 를 쓰면 매 토큰이 애니메이션을
  // 새로 시작해서 사용자가 휠을 굴리는 내내 화면과 씨름하게 된다. 즉시 이동이 맞다 —
  // 부드러운 이동은 "맨 아래로" 버튼처럼 한 번에 크게 뛸 때만 값어치가 있다.
  useEffect(() => {
    if (!isUserScrolledUp.current) {
      bottomRef.current?.scrollIntoView({ behavior: "auto" });
    }
  }, [messages]);

  return (
    <div
      className="chat-messages"
      ref={containerRef}
      onScroll={handleScroll}
      onWheel={handleUserScroll}
      onTouchMove={handleUserScroll}
    >
      {messages.length === 0 && onPickSuggestion && (
        <ChatEmptyState onPick={onPickSuggestion} />
      )}
      {messages.map((m) => (
        <div key={m.id} className={`message message--${m.role}`}>
          {m.role === "assistant" && m.plan && m.plan.length > 0 && (
            <PlanChecklist steps={m.plan} />
          )}

          {m.role === "assistant" && m.steps && m.steps.length > 0 && (
            <AgentStepAccordion
              steps={m.steps}
              isRunning={isRunning && !!m.isStreaming}
            />
          )}

          {(m.content || m.isStreaming || (m.attachments && m.attachments.length > 0) || (m.images && m.images.length > 0)) && (
            <div className="message__bubble">
              {m.role === "assistant" && m.content && !m.isStreaming && (
                <CopyButton text={m.content.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/\[\[PET_STATE:\w+\]\]/g, "").trim()} />
              )}
              {m.isStreaming && m.thinking && !m.content && (
                <div className="message__thinking">
                  <span className="message__thinking-icon">💭</span>
                  {m.thinking}
                </div>
              )}
              {m.content && (
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  components={{
                    table: ({ children }) => (
                      <div className="table-wrapper"><table>{children}</table></div>
                    ),
                    a: ({ href, children }) => (
                      // Tauri webview 는 <a> 클릭을 자기 창에서 처리해 브라우저를 안 띄운다.
                      // 가로채서 기본 브라우저로 연다(http/https 만, Rust 에서 재검증).
                      <a
                        href={href}
                        onClick={(e) => {
                          e.preventDefault();
                          if (href) invoke("open_external_url", { url: href }).catch(() => {});
                        }}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {m.content.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()}
                </ReactMarkdown>
              )}
              {m.images && m.images.length > 0 && (
                <div className="message__images">
                  {m.images.map((url, i) => (
                    <img key={i} src={url} alt="생성된 이미지" className="message__image" />
                  ))}
                </div>
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

function resizeImageForLlm(file: File, maxPx = 768): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onerror = () => resolve("");
    reader.onload = (e) => {
      const src = e.target?.result as string;
      const img = new Image();
      img.onerror = () => resolve(src); // fallback: return original
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
        const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
        const quality = mime === "image/jpeg" ? 0.82 : undefined;
        resolve(canvas.toDataURL(mime, quality));
      };
      img.src = src;
    };
    reader.readAsDataURL(file);
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
        if (file.type.startsWith("image/")) {
          const dataUrl = await resizeImageForLlm(file);
          return { name: file.name, content: "", dataUrl, size: file.size, type: file.type };
        }
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
            title="보내기"
          >
            <ArrowUp size={16} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}

// ── Confirm banner ────────────────────────────────────────────────────────────

/** 규칙 키에서 사람이 읽을 부분만 꺼낸다. `code.exec:shell:git status` → `git status`. */
function ruleLabel(ruleKey: string): string {
  const parts = ruleKey.split(":");
  return parts[parts.length - 1] || ruleKey;
}

function ConfirmBanner({
  confirm,
  onResolve,
}: {
  confirm: PendingConfirm;
  onResolve: (decision: PermissionDecision) => void;
}) {
  // 위험 패턴에 걸린 건 규칙으로 미리 승인해둘 수 없다 — 매번 물어야 하므로
  // "세션 동안"·"항상" 버튼 자체를 감춘다.
  const canRemember = !confirm.isDangerous;
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
        <button className="confirm-banner__deny" onClick={() => onResolve("deny")}>
          거부
        </button>
        {canRemember && (
          <>
            <button
              className="confirm-banner__remember"
              onClick={() => onResolve("allow_session")}
              title={`이 세션 동안 ${confirm.ruleKey} 를 묻지 않아요`}
            >
              세션 동안
            </button>
            <button
              className="confirm-banner__remember"
              onClick={() => onResolve("allow_always")}
              title={`앞으로 ${confirm.ruleKey} 를 묻지 않아요`}
            >
              항상 ({ruleLabel(confirm.ruleKey)})
            </button>
          </>
        )}
        <button
          className={`confirm-banner__allow ${confirm.isDangerous ? "confirm-banner__allow--danger" : ""}`}
          onClick={() => onResolve("allow_once")}
        >
          한 번만
        </button>
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
  // 세션 상태는 sessionStore 소유. 이름은 그대로라 아래 44개 사용처는 무변경.
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setSessions = useSessionStore((s) => s.setSessions);
  const setActiveId = useSessionStore((s) => s.setActiveId);

  // ── Cat variant ───────────────────────────────────────────────────────────
  // 고양이 외형은 catStore 가 소유한다(CatCanvas 가 구독, SettingsModal 이 변경).

  // ── Model context length (from llama.cpp /props) ─────────────────────────
  const [modelContextLength, setModelContextLength] = useState<number | null>(null);
  /** 시작할 때 활성 프로필에 못 붙었다. 세션 오류와 별개라 따로 들고 있는다. */
  const [connectError, setConnectError] = useState<string | null>(null);
  useEffect(() => {
    fetchLoadedModel().then((info) => {
      if (info?.context_length) setModelContextLength(info.context_length);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    return appEvents.on("agentDone", () => {
      fetchLoadedModel().then((info) => {
        if (info?.context_length) setModelContextLength(info.context_length);
      }).catch(() => {});
    });
  }, []);

  // ── Per-session messages: Record<sessionId, ChatMessage[]> ────────────────
  // 메시지 상태는 messageStore 소유. 이름은 그대로 두어 아래 사용처는 무변경.
  const allMessages = useMessageStore((s) => s.messages);
  const setAllMessages = useMessageStore((s) => s.setAll);

  // ── Per-session compact summaries (상단 접이식 요약 바) ──────────────────────
  const [compactSummaries, setCompactSummaries] = useState<Record<string, string>>(() => {
    const result: Record<string, string> = {};
    sessions.forEach((s) => {
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
      const msgs = await conversationApi.load(sessionId);
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

  // ── 일정 알림 (60초마다 체크, 15분 이내 시작 일정) ──────────────────────────
  useEffect(() => {
    const NOTIF_KEY = () => `nekodesk_notified_${new Date().toLocaleDateString("ko-KR")}`;

    function getNotified(): Set<number> {
      try { return new Set(JSON.parse(localStorage.getItem(NOTIF_KEY()) ?? "[]")); }
      catch { return new Set(); }
    }
    function saveNotified(set: Set<number>) {
      localStorage.setItem(NOTIF_KEY(), JSON.stringify([...set]));
    }

    async function checkUpcoming() {
      try {
        const events = await scheduleApi.list("today");
        const now = Date.now();
        const notified = getNotified();
        let changed = false;
        for (const ev of events) {
          if (notified.has(ev.id) || ev.all_day) continue;
          const start = parseEventDate(ev.start_at).getTime();
          const diff = start - now;
          if (diff > 0 && diff <= 15 * 60 * 1000) {
            const mins = Math.round(diff / 60000);
            const msg = mins <= 1 ? `곧 시작돼요!` : `${mins}분 후 시작해요`;
            // ev.title 은 LLM(schedule_add)이 쓸 수 있는 값이므로 절대 스크립트 소스로 넘기지 않는다.
            await invoke("notify_send", {
              title: `📅 ${ev.title}`,
              body: msg,
            }).catch(() => {});
            notified.add(ev.id);
            changed = true;
          }
        }
        if (changed) saveNotified(notified);
      } catch {}
    }

    checkUpcoming();
    const id = window.setInterval(checkUpcoming, 60_000);
    return () => window.clearInterval(id);
  }, []);

  // ── 데일리 브리핑 (하루 첫 실행 시 오늘 날씨+일정+TODO 메시지 삽입) ────────
  const briefingDoneRef = useRef(false);
  useEffect(() => {
    if (briefingDoneRef.current) return;
    briefingDoneRef.current = true;

    const today = new Date().toLocaleDateString("ko-KR");
    if (localStorage.getItem("nekodesk_briefing_date") === today) return;

    async function runBriefing() {
      try {
        const location = await settingsApi.get("weather_location").catch(() => "서울");
        const [weatherRaw, todayEvents, openTodos] = await Promise.all([
          invoke<string>("weather_get", { location: location || "서울" }).catch(() => null),
          scheduleApi.list("today").catch(() => [] as ScheduleEvent[]),
          todosApi.list().catch(() => [] as Todo[]),
        ]);

        const weatherLine = weatherRaw
          ? weatherRaw.split("\n").slice(0, 2).join(" · ")
          : null;

        const eventLines = todayEvents.length === 0
          ? "없음"
          : todayEvents.map((e) => {
              const time = e.all_day ? "종일" : parseEventDate(e.start_at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
              return `${time} ${e.title}`;
            }).join(", ");

        const todoLines = openTodos.length === 0
          ? "없음"
          : openTodos.slice(0, 5).map((t) => t.content).join(", ");

        const lines: string[] = ["☀️ **오늘의 브리핑**\n"];
        if (weatherLine) lines.push(`🌤 **날씨** ${weatherLine}`);
        lines.push(`📅 **오늘 일정** (${todayEvents.length}개) ${eventLines}`);
        lines.push(`✓ **할 일** (${openTodos.length}개) ${todoLines}`);
        lines.push("\n좋은 하루 되세요! 🐱");

        const briefingMsg = {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          content: lines.join("\n"),
          time: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
          steps: [],
          isStreaming: false,
        };

        setAllMessages((prev) => {
          const cur = prev[activeId] ?? [];
          return { ...prev, [activeId]: [briefingMsg, ...cur] };
        });
        localStorage.setItem("nekodesk_briefing_date", today);
      } catch {}
    }

    // DB 세션 로드 후 삽입되도록 짧게 지연
    const id = window.setTimeout(runBriefing, 800);
    return () => window.clearTimeout(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Active session's messages
  const activeMessages = allMessages[activeId] ?? [];

  // ── Agent pool (parallel per-session processing) ──────────────────────
  const pool = useAgentPool();
  const { state: rpgState, dayCount, canFeed, feed, playAction, pet, reward } = useCatRpg();

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

  const isBoxModeRef = useRef(isBoxMode);
  isBoxModeRef.current = isBoxMode;

  // 쓰다듬기는 이제 CatCanvas 안에서 트랙패드로 처리한다(useTrackpadPet).
  // 가속도계는 M4에서 root 데몬이 필요해 폐기했다.

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

  const promptTokens = pool.contextTokens(activeId);
  const displayHunger =
    promptTokens === 0 || modelContextLength == null
      ? 100
      : Math.max(0, Math.round(100 - (promptTokens / modelContextLength) * 100));

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

      const previousSummary = compactSummaries[activeId] || undefined;
      const summary = await compactMessages(llmMessages, previousSummary);

      // 요약은 챗버블이 아닌 상단 요약 바에 표시
      setCompactSummaries((prev) => ({ ...prev, [activeId]: summary }));
      localStorage.setItem(`nekodesk_compact_${activeId}`, summary);
      setSummaryExpanded(false);

      // 대화 메시지는 초기화 (새 시작)
      setAllMessages((prev) => ({ ...prev, [activeId]: makeInitialMessages() }));
      loadedSessionsRef.current.delete(activeId); // 재로드 방지

      // DB 초기화
      await conversationApi.delete(activeId);

      pool.clearContextTokens(activeId);
      feed();
      triggerActionEmotion("proud");
    } catch {
      // compact 실패해도 무음 처리
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting, allMessages, activeId, feed, triggerActionEmotion, setAllMessages, setCompactSummaries, setSummaryExpanded, pool]);

  const wordChain = useWordChainGame(triggerActionEmotion);

  useEffect(() => {
    return appEvents.on("wordchainGameover", () => {
      reward(Math.min(20, Math.floor(wordChain.turnCount / 2)));
      wordChain.endGame();
    });
  }, [wordChain.endGame, wordChain.turnCount, reward]);

  const injectMessage = useCallback((role: "user" | "assistant", content: string) => {
    const msg = {
      id: crypto.randomUUID(),
      role,
      content,
      time: new Date().toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }),
      steps: [] as [],
      isStreaming: false,
    };
    setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] ?? []), msg] }));
  }, [activeId, setAllMessages]);

  const handleSend = useCallback(async (text: string, files: AttachedFile[]) => {
    markUserActivity();

    // 게임 시작은 모델을 거치지 않는다.
    //
    // game.start 툴이 있는데도 작은 모델은 채팅으로 게임을 흉내내는 쪽으로 샜고,
    // 흉내낸 게임은 규칙부터 틀렸다("'강'으로 끝나는 단어를 대라" 같은 식으로).
    // 규칙은 코드가 아는데 모델의 판단을 끼워 넣을 이유가 없다.
    // "진행 중" 이 아니면 시작할 수 있다. 끝난 게임은 phase 가 "done" 으로 남는데,
    // 예전에는 "idle" 만 봐서 "끝말잇기 더 하자" 가 모델로 새어나갔다 — 그리고 모델은
    // 또 채팅으로 흉내냈다.
    const midGame =
      (game.phase !== "idle" && game.phase !== "done") ||
      (wordChain.phase !== "idle" && wordChain.phase !== "done");
    if (!midGame) {
      const intent = detectGameIntent(text);
      if (intent) {
        injectMessage("user", text.trim());
        MINI_GAMES.find((g) => g.id === intent)?.launch();
        return;
      }
    }

    // 끝말잇기 게임 중: 한국어 단어 하나만 게임으로 처리, 그 외는 일반 채팅
    if (wordChain.phase === "user_turn") {
      const trimmed = text.trim();
      const isSingleWord = /^[가-힣]{2,10}$/.test(trimmed);

      if (isSingleWord) {
        injectMessage("user", trimmed);
        const result = await wordChain.submitWord(trimmed);
        if (
          result.type === "invalid_word" ||
          result.type === "invalid_start" ||
          result.type === "duplicate"
        ) {
          injectMessage("assistant", `앗! ${result.error} 😸`);
        } else if (result.type === "user_invalid") {
          injectMessage("assistant", `"${result.word}"는 사전에 없는 단어야! 속이려 했지? 😾 고양이 승리! (${wordChain.turnCount}턴)`);
        } else if (result.type === "cat_failed") {
          injectMessage("assistant", `"${result.neededChar}"${roParticle(result.neededChar)} 시작하는 단어가 생각이 안 나... 항복! 유저 승리 🏆 (${wordChain.turnCount}턴)`);
          reward(Math.min(20, Math.floor(wordChain.turnCount / 2)));
        } else if (result.type === "cat_word") {
          injectMessage("assistant", `${result.catWord} 😸`);
        } else {
          injectMessage("assistant", `앗, 뭔가 잘못됐어. 게임을 다시 시작해줘! 😿`);
        }
      } else {
        injectMessage("user", trimmed);
        injectMessage("assistant", `끝말잇기 중이야! 한글 단어만 입력해줘 😺\n"${wordChain.lastChar}"${roParticle(wordChain.lastChar)} 시작하는 단어를 입력해봐!`);
      }
      return;
    }

    void pool.sendMessage(activeId, text, files, undefined, compactSummaries[activeId] || undefined);
  // game 은 이 콜백보다 아래에서 선언돼 의존성 배열에 못 넣는다(TDZ). 본문에서만 읽는다 —
  // wordChain 이 바뀔 때마다 콜백이 새로 만들어져 실제로 뒤처지는 창은 좁고, 뒤처져도
  // 최악이 "그림 게임 중에 끝말잇기가 시작됨" 정도다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markUserActivity, pool, activeId, wordChain, injectMessage, compactSummaries]);

  // 세션/activeId 영속화는 sessionStore 액션 안에서 처리한다(예전 useEffect 대체).

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
    conversationApi.delete(id).catch(() => {});
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
  // 저장해둔 "항상 허용" 규칙을 메모리에 올린다. 이게 없으면 첫 요청은
  // 이미 승인한 명령에도 확인 창이 뜬다.
  useEffect(() => { loadPermissionRules(); }, []);
  // 사용자가 ~/.nekodesk/skills/ 에 넣어둔 지식을 읽어둔다.
  useEffect(() => { reloadUserSkills(); }, []);

  // 앱을 켜면 마지막에 쓰던 프로필로 되돌아간다. 로컬 모델이면 서버를 띄우고,
  // 외부 서버면 주소를 맞춘 뒤 살아 있는지 확인한다 — 꺼져 있다는 걸 첫 질문을
  // 던지고 나서야 알게 되면 늦다.
  useEffect(() => {
    const { profiles, activeId: profileId } = loadProfiles();
    const active = profiles.find((p) => p.id === profileId);
    if (!active) return;
    activateProfile(active)
      .then(async () => {
        // 관리형은 llama_start 가 즉시 죽었는지 이미 확인했다. 모델 로딩엔 수십 초가
        // 걸리므로 여기서 또 찔러보면 멀쩡한 서버를 죽었다고 오해한다.
        if (active.config) return;
        if ((await probe(profileUrl(active), 3000)) === null) {
          setConnectError(`'${active.name}' 서버에 연결되지 않았어. 설정 → 모델 프로필에서 확인해줘.`);
        }
      })
      .catch((e) => setConnectError(String(e)));
  }, []);

  const [menuOpen, setMenuOpen] = useState(false);
  const [gameSpeech, setGameSpeech] = useState<string | null>(null);
  const game = useDrawingGame(triggerActionEmotion, setGameSpeech, () => reward(10));

  useEffect(() => {
    if (game.phase !== "idle") {
      setSidebarW(400);
    } else {
      setSidebarW(220);
    }
  }, [game.phase]);

  // ── Mini-game registry — 새 게임 추가 시 여기에만 항목 추가 ─────────────────
  const MINI_GAMES = [
    {
      id: "drawing",
      launch: () => { game.startSetup(); },
    },
    {
      id: "wordchain",
      launch: (requestId?: number) => {
        wordChain.startGame().then((firstWord) => {
          // 에이전트 요청이면 첫 단어를 그쪽으로 돌려준다. 직접 시작이면 직접 메시지.
          const delivered = resolveWordchainFirstWord(requestId, firstWord);
          if (!delivered) {
            if (firstWord) {
              const next = firstWord[firstWord.length - 1];
              injectMessage("assistant", `끝말잇기 시작! 내가 먼저 할게. "${firstWord}" 😸\n"${next}"${roParticle(next)} 시작하는 단어를 입력해봐!`);
            } else {
              injectMessage("assistant", "앗, 단어를 못 떠올렸어. 다시 시작해줘!");
            }
          }
        });
      },
    },
  ] as const;

  function launchRandomGame() {
    if (game.phase !== "idle" || wordChain.phase !== "idle") return;
    const pick = MINI_GAMES[Math.floor(Math.random() * MINI_GAMES.length)];
    pick.launch();
  }

  // game.start 도구 이벤트 처리 (MINI_GAMES 정의 이후에 위치)
  useEffect(() => {
    return appEvents.on("startGame", (payload) => {
      if (payload.type === "wordchain") {
        MINI_GAMES[1].launch(payload.requestId);
      } else {
        MINI_GAMES[0].launch();
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  const {
    sidebarVisible,
    rightPanelVisible,
    setRightPanelVisible,
    setSidebarW,
    isDragging,
    startDrag,
    appStyle,
  } = useLayout();

  // ── ⌘K 커맨드 팔레트 ───────────────────────────────────────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (k === "n") {
        e.preventDefault();
        handleNew();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const paletteCommands = useMemo<Command[]>(() => {
    const base: Command[] = [
      { id: "new", icon: "✍️", label: "새 대화", hint: "⌘N", keywords: "new chat 새대화", run: handleNew },
      { id: "settings", icon: "⚙️", label: "설정 열기", keywords: "settings 설정 환경설정", run: () => setMenuOpen(true) },
      {
        id: "theme",
        icon: isDark ? "☀️" : "🌙",
        label: isDark ? "라이트 모드로 전환" : "다크 모드로 전환",
        keywords: "theme dark light 테마 다크 라이트",
        run: toggleTheme,
      },
      {
        id: "rightpanel",
        icon: "🐱",
        label: rightPanelVisible ? "고양이 패널 숨기기" : "고양이 패널 보기",
        keywords: "panel 패널 고양이",
        run: () => setRightPanelVisible((v) => !v),
      },
      { id: "delete", icon: "🗑️", label: "현재 대화 삭제", keywords: "delete 삭제 지우기", run: () => handleDelete(activeId) },
    ];
    const go: Command[] = sessions
      .filter((s) => s.id !== activeId)
      .slice(0, 20)
      .map((s) => ({
        id: `go-${s.id}`,
        icon: "💬",
        label: `이동: ${s.title}`,
        hint: s.date,
        keywords: `session 세션 이동 ${s.title}`,
        run: () => setActiveId(s.id),
      }));
    return [...base, ...go];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDark, rightPanelVisible, sessions, activeId]);

  return (
    <div className={`app${isDragging ? " app--resizing" : ""}`} style={appStyle}>
      <TitleBar
        sessionTitle={activeSession?.title ?? ""}
        onSettings={() => setMenuOpen(true)}
        isDark={isDark}
        onThemeToggle={toggleTheme}
        rightPanelVisible={rightPanelVisible}
        onToggleRightPanel={() => setRightPanelVisible((v) => !v)}
      />
      {menuOpen && (
        <ErrorBoundary label="설정">
          <MenuModal onClose={() => setMenuOpen(false)} isDark={isDark} />
        </ErrorBoundary>
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
      />

      <ErrorBoundary label="사이드바">
      <Sidebar
        onNew={handleNew}
        onDelete={handleDelete}
        emotion={displayEmotion}
        gameSpeech={gameSpeech}
        rpg={{
          dayCount,
          hunger: displayHunger,
          play: rpgState.play,
          canFeed,
          feedCountToday: rpgState.feedCountToday,
          isCompacting,
          onFeed: () => { void handleFeed(); },
          onPlay: () => { triggerActionEmotion("happy"); launchRandomGame(); },
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
        contextTokens={promptTokens}
        modelContextLength={modelContextLength}
        gameMode={game.phase !== "idle" ? game : null}
      />
      </ErrorBoundary>

      <main className="main">

        {connectError && (
          <ErrorBanner message={connectError} onDismiss={() => setConnectError(null)} />
        )}

        {error && (
          <ErrorBanner message={error} onDismiss={() => pool.clearError(activeId)} />
        )}

        {wordChain.phase !== "idle" && (
          <div className="wordchain-banner">
            <span className="wordchain-banner__status">
              {wordChain.phase === "user_turn"
                ? `끝말잇기 — "${wordChain.lastChar}"로 시작하는 단어를 입력하세요`
                : wordChain.phase === "cat_turn"
                ? "고양이가 생각 중..."
                : "게임 종료"}
            </span>
            <span className="wordchain-banner__turns">{wordChain.turnCount}턴</span>
            {wordChain.phase === "user_turn" && (
              <button
                className="wordchain-banner__dispute"
                onClick={() => {
                  void pool.sendMessage(activeId, wordChain.disputeContext(), [], "이의 제기!");
                }}
                title="방금 나온 단어 검증 요청"
              >이의 제기</button>
            )}
            <button className="wordchain-banner__close" onClick={() => { wordChain.reset(); }}>✕</button>
          </div>
        )}

        <div className="chat-area">
          {compactSummaries[activeId] && (
            <CompactSummaryBar
              summary={compactSummaries[activeId]}
              expanded={summaryExpanded}
              onToggle={() => setSummaryExpanded((v) => !v)}
            />
          )}

          <ErrorBoundary label="채팅">
            <ChatMessages
              messages={activeMessages}
              isRunning={isRunning}
              onScrollChange={handleScrollChange}
              onPickSuggestion={(text) => handleSend(text, [])}
            />
          </ErrorBoundary>
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
          isRunning={isRunning || wordChain.phase === "cat_turn"}
        />
      </main>

      <ErrorBoundary label="패널">
        <RightPanel
          onResizeStart={rightPanelVisible ? (e) => startDrag("right", e) : undefined}
          isResizing={isDragging === "right"}
        />
      </ErrorBoundary>
    </div>
  );
}

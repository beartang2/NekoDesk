import React, { useRef, useEffect, useLayoutEffect, useState, useCallback, useMemo } from "react";
import { PhonePanel } from "./neko/PhonePanel";
import { AlertDialog } from "radix-ui";
import { PairLinkPrompt } from "./components/PairLink";
import { bindPanels, dismissKeyboard, drawer, type Panels } from "./lib/phone";
import { IS_PHONE } from "./lib/platform";
import { useStandby } from "./lib/standby";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { MD_PLUGINS } from "./lib/markdown";
import { tableWheel } from "./lib/tableWheel";
import { Sun, Moon, Monitor, Settings, Paperclip, ArrowUp, Zap, Copy, Check, X, Gift, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { historyStep, type HistoryPos } from "./lib/input-history";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { AgentStepAccordion } from "./components/AgentStepAccordion";
import { GameSpeechBubble } from "./components/GameSpeechBubble";
import { useRevealChildren, useScrollEdges } from "./hooks/useScrollReveal";
import { Counter } from "./components/Counter";
import LatticeLoader from "./components/LatticeLoader";
import { Attachments } from "./components/Attachments";
import { PlanChecklist } from "./components/PlanChecklist";
import { ChatEmptyState } from "./components/ChatEmptyState";
import { NekoBootCat } from "./neko/NekoPortrait";
import { NekoSlot } from "./neko/NekoSlot";
import { RoomBackdrop } from "./neko/NekoRoom";
import { splitMarkdownBlocks } from "./lib/markdownBlocks";
import { addPictureGift } from "./neko/pictureGift";
import { useNekoDirector } from "./neko/useNekoDirector";
import { nekoWrites, useNekoApp } from "./neko/director/stores";
import { watchWalkIdle } from "./neko/walkWatch";
import { restThink, takeGreeting } from "./agent/neko-mind";
import { reportBigState, watchPresence } from "./neko/presence";
import { watchDreams } from "./neko/dream";
import { useNekoNeeds } from "./neko/director/needsStore";
import { SLEEPY_MS } from "./neko/director/derive";
import { useNekoStore } from "./neko/nekoStore";
import { CatStatusPanel } from "./components/CatStatusPanel";
import { RightPanel, DrawingPadCard, parseEventDate } from "./components/RightPanel";
import { MenuModal } from "./components/MenuModal";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { useDrawingGame } from "./hooks/useDrawingGame";
import { useWordChainGame } from "./hooks/useWordChainGame";
import { useAgentPool, makeInitialMessages, modelSwitches, parseMeta, serializeMeta, splitAttachmentSection, type QueuedMessage } from "./hooks/useAgentLoop";
import { useMessageStore } from "./stores/messageStore";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { UpdatePrompt } from "./components/Update";
import { openViewer, imageName, nowStamp } from "./components/Viewer";
import { maskHome } from "./lib/home";
import { useCatRpg } from "./hooks/useCatRpg";
import { todosApi, scheduleApi, settingsApi, conversationApi, migrateLegacySecrets, securityApi, mapApi, SYNC_CHANGED, type SyncChanged, syncApi } from "./api/tauri";
import { appEvents, resolveWordchainFirstWord } from "./lib/events";
import { relistSessions, removeSession, useSessionStore, makeSession, type Session } from "./stores/sessionStore";
import { isClaudeActive, nekoNameOf, useSettingsStore } from "./stores/settingsStore";
import { budgetBlockReason } from "./stores/claudeBudget";
import { startWalkBrain, type WalkBefore, type WalkBrain } from "./agent/walk";
import { useNekoController } from "./neko/nekoHost";
import { buildPath, EXTRA_WAIT_MS, fallbackLegs, hurryHome, lastWalkWith, walkingElsewhere, nextWalkAt, pickPlaces, routineName, positionAt, toLatLon, toMeters, walkEnd, walkStart, WALK_MS, type Pt, type SharedWalk, type Walk } from "./lib/walk";
import { hereOnce, watchHere } from "./lib/here";
import { watchWindowMin } from "./lib/windowMin";
import { DEFAULT_SIDEBAR_W, useLayout } from "./hooks/useLayout";
import { initMcpFromStorage } from "./agent/mcp-registry";
import { isAutoApprove, loadPermissionRules, setAutoApprove } from "./agent/permissions";
import { reloadUserSkills } from "./agent/knowledge";
import { detectGameIntent } from "./lib/game-intent";
import { josa, roParticle } from "./lib/hangul";

// 모델의 `<think>` 블록·감정 태그 떼기는 lib/replyTags 한 곳(선물 설명도 같이 쓴다)
import { stripPetState, stripThink } from "./lib/replyTags";
import { storeFile, removeFile } from "./agent/file-store";
import { resizeImageForLlm } from "./lib/image";
import { auroraTints, wave } from "./lib/aurora";
import { systemDarkQuery, useThemePref, windowTheme, type ThemePref } from "./lib/theme";
import { applyThemeColors } from "./theme-colors";
import type { ChatMessage, AttachedFile, PendingConfirm, PendingClarify } from "./hooks/useAgentLoop";
import type {
  CatEmotion,
  LlmMessage,
  PermissionDecision,
  ScheduleEvent,
  Todo,
} from "./agent/types";
import { fetchLoadedModel, summarizeConversation } from "./agent/llm-client";
import { activateProfile, isClaudeProfile, loadProfiles, probe, profileUrl, saveProfiles } from "./stores/modelProfiles";
import { listen } from "@tauri-apps/api/event";
import { useNekoScreen } from "./neko/remoteNeko";
import { useDevTools } from "./neko/devTools";
import { buildQuickPrompt, QUICK_ASK_EVENT, type QuickAskPayload } from "./lib/quick-ask";
import { clock, parseDbTime } from "./lib/time";

import "./App.css";

// ── Session types ─────────────────────────────────────────────────────────────

/** 산책 기록(lib/walk 의 Walk). 다녀온 뒤에도 남겨 다음 산책(정기 산책·추가 산책 간격)을 정한다. */
const WALK_KEY = "neko_walk";
/** 다른 기기에 보이는 산책(동기화되는 설정, Rust db::SYNCED_SETTINGS). 내용은 WALK_KEY 와 같다 */
const WALK_VIEW_KEY = "neko_walk_view";
/** 다녀온 지난 산책의 시작·끝(다음 산책 정하기용). 아직 안 다녀왔거나 기록이 없으면 null */
const lastWalkOf = (w: Walk | null) => (w?.done ? { start: walkStart(w), end: walkEnd(w) } : null);

// 세션 상태는 sessionStore 가 소유한다(Session/makeSession 도 거기서 재노출).

// ── Title bar ─────────────────────────────────────────────────────────────────

/** CSS 색(oklch 등)을 0–1 RGB 로(캔버스가 풀어 준다) */
function cssRgb(color: string): [number, number, number] {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const x = c.getContext("2d");
  if (!x) return [0, 0, 0];
  x.fillStyle = color.trim() || "#000";
  x.fillRect(0, 0, 1, 1);
  const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
  return [r / 255, g / 255, b / 255];
}

function useTheme() {
  const pref = useThemePref((s) => s.pref);
  const setPref = useThemePref((s) => s.setPref);
  // macOS 값은 웹뷰(matchMedia)가 아니라 창에 묻는다. 창 설정의 "theme": "Dark" 로 켜진 웹뷰는
  // setTheme(null) 뒤에도 다크라고 답해서, 라이트 맥에서 시스템으로 둬도 다크로 켜졌다.
  // 첫 값은 깜빡임을 줄이려는 어림값이고, 아래 theme() 가 곧 바로잡는다.
  const [systemDark, setSystemDark] = useState(() => systemDarkQuery().matches);
  const prefRef = useRef(pref);
  prefRef.current = pref;
  useEffect(() => {
    if (IS_PHONE) {
      // 폰: 창 테마(Tauri)는 iOS 에서 오지 않는다 — 웹 표준으로 읽는다. 밝게·어둡게로 박아 둔 동안엔 창에 건 값(phone_theme)이
      // 오니 시스템 값으로 받지 않는다. 낮밤 자동 전환은 앱을 쓰는 중이면 바로, 뒤에 있었으면 앞으로 올 때 맞춘다
      const q = systemDarkQuery();
      const on = () => { if (prefRef.current === "system" && !document.hidden) setSystemDark(q.matches); };
      q.addEventListener("change", on);
      document.addEventListener("visibilitychange", on);
      return () => { q.removeEventListener("change", on); document.removeEventListener("visibilitychange", on); };
    }
    // macOS 설정이 바뀌면 온다. 라이트·다크로 박아 둔 동안엔 그 값이 오지만 그땐 쓰지 않는다.
    const off = getCurrentWindow().onThemeChanged(({ payload }) => setSystemDark(payload === "dark"));
    return () => void off.then((f) => f()).catch(() => {});
  }, []);
  const isDark = pref === "system" ? systemDark : pref === "dark";

  useEffect(() => {
    if (IS_PHONE) return;
    const w = getCurrentWindow();
    w.setTheme(windowTheme(pref))
      .then(() => (pref === "system" ? w.theme() : null))
      .then((t) => { if (t) setSystemDark(t === "dark"); })
      .catch(() => {});
  }, [pref]);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("theme-transitioning");
    root.classList.toggle("light", !isDark);
    applyThemeColors(isDark);
    const t = setTimeout(() => root.classList.remove("theme-transitioning"), 250);
    return () => clearTimeout(t);
  }, [isDark]);

  // 폰: 고른 테마를 창에 건다 — 상태 막대 글자·키보드 색이 따라오고, 웹뷰·창 바탕을 앱 바탕색으로 칠해 바뀌는 사이
  // 흰 바탕이 비치지 않게 한다. 시스템이면 창은 iOS 를 따른다. 답은 iOS 자체 값(창에 건 값과 상관없음) — 시스템으로 돌아갈 때 맞는 값이 있게 늘 받는다
  // 가로 화면은 거실 벽 색으로 칠한다 — iOS 가 화면 그림을 버린 순간 보이는 바탕이 하얗게 튀지 않게(벽과 같은 색)
  const standby = useStandby();
  useEffect(() => {
    if (!IS_PHONE) return;
    const style = pref === "system" ? 0 : pref === "dark" ? 2 : 1;
    const wall = standby ? document.querySelector(".neko-slot--dock .neko-room__wall") : null;
    const bg = wall ? getComputedStyle(wall).fill : getComputedStyle(document.documentElement).getPropertyValue("--bg-base");
    invoke<boolean>("phone_theme", { style, bg: cssRgb(bg) })
      .then(setSystemDark)
      .catch(() => {});
  }, [pref, isDark, standby]);

  return { isDark, pref, cycle: () => setPref(THEME_NEXT[pref]) };
}

/** 제목 표시줄 테마 버튼. 아이콘은 지금 상태, 누르면 다음 것으로 넘어간다. */
const THEME_NEXT: Record<ThemePref, ThemePref> = { light: "dark", dark: "system", system: "light" };
const THEME_LABEL: Record<ThemePref, string> = { light: "라이트", dark: "다크", system: "시스템" };
const THEME_ICON: Record<ThemePref, typeof Sun> = { light: Sun, dark: Moon, system: Monitor };

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

/** 채팅 위 오로라 빛 다섯 덩이의 가운데 자리(가로·세로 0~1). 사이 덩이는 조금 위에 둔다. */
const AURORA_AT: [x: number, y: number][] = [
  [0.14, 0.3],
  [0.3, 0.18],
  [0.46, 0.26],
  [0.66, 0.18],
  [0.86, 0.34],
];

function TitleBar({
  sessionTitle,
  onSettings,
  themePref,
  onThemeToggle,
  rightPanelVisible,
  onToggleRightPanel,
  onSessions,
}: {
  /** 폰: 제목을 누르면 대화 목록이 열린다(사이드바가 따로 없다). */
  onSessions?: () => void;
  sessionTitle: string;
  onSettings: () => void;
  themePref: ThemePref;
  onThemeToggle: () => void;
  rightPanelVisible: boolean;
  onToggleRightPanel: () => void;
}) {
  const ThemeIcon = THEME_ICON[themePref];
  return (
    <header
      className="titlebar"
      // 끌기·두 번 눌러 확대는 macOS 에 맡긴다(Tauri start_dragging). 27.2 에서 이게 고장 나
      // JS 가 매 프레임 setPosition 으로 직접 옮겼는데, 배율 다른 화면 경계에서 위치가 튀어
      // 창이 두 화면을 오가며 깜빡이고 MenuBarAgent 가 CPU 를 먹었다. 27.3 에서 기본 끌기가 다시 된다.
      data-tauri-drag-region="deep"
    >
      <span className="titlebar__name">NekoDesk</span>
      <span className="titlebar__sep">/</span>
      {onSessions ? (
        <button type="button" className="titlebar__session titlebar__session--btn" onClick={onSessions}>{sessionTitle || "대화 목록"} ▾</button>
      ) : (
        <span className="titlebar__session">{sessionTitle}</span>
      )}
      <button className="titlebar__settings" onClick={onThemeToggle}
        title={`테마: ${THEME_LABEL[themePref]} — 누르면 ${THEME_LABEL[THEME_NEXT[themePref]]}`}>
        <ThemeIcon size={14} />
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

/**
 * 켤 때 잠깐 보이는 부팅 화면. 창은 작게 뜨고(tauri.conf), 네코가 졸다가 기지개를 켠 뒤
 * window_boot_done 이 창을 본 크기로 부드럽게 키운다. 다 커지면 걷힌다.
 */
const BOOT_MS = 1400;
/** 창 키우기(보통 0.6초)를 이만큼만 기다리고 걷는다. 못 키워도 최소 크기는 Rust 가 따로 건다 */
const BOOT_GROW_WAIT_MS = 4000;

function BootSplash() {
  const nekoName = useSettingsStore(nekoNameOf);
  const [animDone, setAnimDone] = useState(false);
  const [phase, setPhase] = useState<"booting" | "leaving" | "gone">("booting");

  useEffect(() => {
    if (!animDone) return;
    const wait = new Promise((r) => setTimeout(r, BOOT_GROW_WAIT_MS));
    Promise.race([document.fonts.ready.then(() => invoke("window_boot_done")), wait])
      .catch(() => {}) // 브라우저(vite 만 띄운 경우)엔 창이 없다. 그냥 걷는다.
      .finally(() => setPhase("leaving"));
  }, [animDone]);

  if (phase === "gone") return null;
  return (
    <div
      className="boot-splash"
      data-leaving={phase === "leaving" ? "" : undefined}
      data-tauri-drag-region
      // 안쪽 로더의 transition 도 여기로 올라온다. 자기 것만 듣는다.
      onTransitionEnd={(e) => { if (e.target === e.currentTarget) setPhase("gone"); }}
    >
      <NekoBootCat size={170} durationMs={BOOT_MS} onDone={() => setAnimDone(true)} />
      <LatticeLoader label={`${nekoName} 깨우는 중`} status="working" showTimer={false} />
    </div>
  );
}

function Sidebar({
  onNew,
  onDelete,
  isRunning,
  rpg,
  onResizeStart,
  isResizing,
  contextTokens,
  modelContextLength,
  gameSpeech,
  gameMode,
  away,
  walk,
  isDark,
}: {
  onNew: () => void;
  onDelete: (id: string) => void;
  /** 답이 흐르는 중인 세션(목록 진행 표시) */
  isRunning: (id: string) => boolean;
  away: boolean;
  walk: Walk | null;
  isDark: boolean;
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
  const standby = useStandby();
  // 세션 목록·활성·선택은 sessionStore 를 직접 구독(prop-drilling 제거).
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const onSelect = useSessionStore((s) => s.setActiveId);
  // 목록 가장자리 페이드 + 화면에 들어온 줄만 올라오기(reactbits AnimatedList).
  const listRef = useRef<HTMLDivElement>(null);
  useScrollEdges(listRef);
  useRevealChildren(listRef);
  return (
    <aside className="sidebar">
      <div className="sidebar__sessions">
      <button className="sidebar__new-btn" onClick={onNew}>
        ＋ 새 대화
      </button>

      <span className="sidebar__section-label">최근</span>
      <div className="sidebar__list" ref={listRef}>
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === activeId ? "session-item--active" : ""} ${s.unread ? "session-item--unread" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <span className="session-item__title">{s.title}</span>
            {/* 열린 대화는 채팅 화면에 진행 표시가 있어 목록엔 안 띄운다 */}
            {s.id !== activeId && isRunning(s.id) ? (
              <span className="session-item__unread session-item__unread--running" role="img" aria-label="답하는 중" title="답하는 중" />
            ) : s.unread && <span className="session-item__unread" role="img" aria-label="새 답" title="새 답" />}
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
      </div>

      <DrawingPadCard gameMode={gameMode} />

      {gameSpeech && <GameSpeechBubble text={gameSpeech} />}

      <div className="cat-panel">
        {/* 네코 방: 배경(벽·바닥·날씨 창문) 위에 네코 자리. 네코가 다른 자리로 가도 빈 방으로 남는다 */}
        <div className="cat-room">
          <RoomBackdrop />
          {/* 폰 가로 화면 동안 방(고양이는 거실에 나와 있다)은 그리지 않는다(lib/standby) */}
          {!standby && <NekoSlot placement="sidebar" onRubPet={rpg.onPet} away={away} walk={walk} isDark={isDark} />}
        </div>
        {/* 방 아래 얇은 띠: DAY·컨텍스트, 밥·놀이 게이지(누르면 밥 주기·놀아주기) */}
        <CatStatusPanel
          ctx={<><Counter value={contextTokens} /> / {modelContextLength != null ? modelContextLength.toLocaleString() : "--"}</>}
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

/** 처음에 그리는 말풍선 수, 그리고 위로 올릴 때마다 더 붙이는 수. */
const MESSAGE_PAGE = 60;

/** 표: 넓으면 옆으로 민다(App.css). 휠·트랙패드는 표 위에서도 세로는 대화 목록으로(lib/tableWheel — 맥 WebKit 이 손짓을 표에 묶었다) */
function MdTable({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => (ref.current ? tableWheel(ref.current) : undefined), []);
  return <div ref={ref} className="table-wrapper"><table>{children}</table></div>;
}

const MD_COMPONENTS: React.ComponentProps<typeof ReactMarkdown>["components"] = {
  table: ({ children }) => <MdTable>{children}</MdTable>,
  // 칸 안을 한 겹 감싼다: 폰은 이 겹에 칸의 최소·최대 폭을 준다(표 칸 자체의 max-width 는 브라우저마다 안 먹는다, App.css)
  th: ({ node: _n, children, ...rest }) => <th {...rest}><div className="md-cell">{children}</div></th>,
  td: ({ node: _n, children, ...rest }) => <td {...rest}><div className="md-cell">{children}</div></td>,
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
};

/** 마크다운 한 덩이. 글이 같으면 다시 해석하지 않는다 */
const MdBlock = React.memo(function MdBlock({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={MD_PLUGINS} components={MD_COMPONENTS}>{text}</ReactMarkdown>;
});

function MessageMarkdown({ text, streaming }: { text: string; streaming: boolean }) {
  if (!streaming) return <MdBlock text={text} />;
  return <>{splitMarkdownBlocks(text).map((b, i) => <MdBlock key={i} text={b} />)}</>;
}

/**
 * 말풍선 하나. 메모라서 답이 흘러나오는 동안엔 그 말풍선만 다시 그린다 — 예전엔 글자 하나마다
 * 대화 전체의 마크다운을 다시 해석해서 대화가 길수록 느려졌다. 메시지 저장소는 바뀐 메시지만
 * 새 객체로 바꾸므로 나머지는 그대로 건너뛴다.
 */
const MessageItem = React.memo(function MessageItem({
  m,
  running,
  expanded,
  onToggle,
  request,
}: {
  m: ChatMessage;
  running: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
  /** 그림이 있는 답이면 그 그림을 부탁한 사용자 말 */
  request?: string;
}) {
  const nekoName = useSettingsStore(nekoNameOf);
  if (m.compacted) {
    return (
      <details className="message-compacted">
        <summary>여기까지 요약했어 — {josa(nekoName, "은/는")} 이 위 대화를 요약으로 기억해</summary>
        <div className="message-compacted__body">
          <ReactMarkdown remarkPlugins={MD_PLUGINS}>{maskHome(m.content)}</ReactMarkdown>
        </div>
      </details>
    );
  }
  return (
    <div className={`message message--${m.role}`}>
      {m.role === "assistant" && <PlanChecklist steps={m.plan ?? []} open={!!m.isStreaming} />}

      {m.role === "assistant" && m.steps && m.steps.length > 0 && (
        <AgentStepAccordion
          steps={m.steps}
          isRunning={running}
        />
      )}

      {(m.content || m.isStreaming || (m.attachments && m.attachments.length > 0) || (m.images && m.images.length > 0)) && (
        <div className="message__bubble">
          {m.label && <span className="message__label">{m.label}</span>}
          {m.thinking && (
            // 생각 텍스트는 접어둔다. 길게 흘러 화면을 밀어내서, 로더·타이머만 보이고 펼쳐야 읽힌다.
            <details className="message__thinking">
              <summary>
                {/* 타이머는 생각하는 동안만. 끝난 뒤 다시 마운트되면 마지막 값을 몰라 0.0s 로 보인다.
                    도는 동안은 since 로 답 칸을 연 시각부터 세서, 대화를 오가도 이어진다. */}
                <LatticeLoader
                  since={m.startedAt}
                  label="생각하는 중"
                  doneLabel="생각 과정"
                  status={m.isStreaming && !m.content ? "working" : "done"}
                  showTimer={!!m.isStreaming && !m.content}
                  fontSize={12}
                  cellSize={3}
                  gap={1}
                  doneColor="var(--accent)"
                />
              </summary>
              {m.thinking}
            </details>
          )}
          {m.content && (
            <MessageMarkdown text={maskHome(stripThink(expanded && m.prompt ? m.prompt : m.content))} streaming={!!m.isStreaming} />
          )}
          {m.role === "user" && m.prompt && (
            <button type="button" className="message__more" onClick={() => onToggle(m.id)}>
              {expanded ? "접기" : "더보기"}
            </button>
          )}
          {m.images && m.images.length > 0 && (
            <div className="message__images">
              {m.images.map((url, i) => (
                <div key={i} className="message__pic">
                  <img
                    src={url}
                    alt="생성된 이미지"
                    className="message__image"
                    onClick={() => openViewer({ name: imageName(`${nekoName} 그림 ${nowStamp()}${m.images!.length > 1 ? ` ${i + 1}` : ""}`, url), dataUrl: url })}
                  />
                  {m.role === "assistant" && !m.isStreaming && <PictureGiftButton src={url} request={request ?? ""} />}
                </div>
              ))}
            </div>
          )}
          {m.attachments && m.attachments.length > 0 && (
            <Attachments files={m.attachments} />
          )}
          {/* 생각 토큰을 안 내는 모델도 있다. 그땐 첫 글자가 올 때까지 로더만 띄운다. */}
          {m.isStreaming && !m.content && !m.thinking && (
            <LatticeLoader since={m.startedAt} label="생각하는 중" fontSize={12} cellSize={3} gap={1} color="var(--text-secondary)" />
          )}
          {m.isStreaming && m.content && <span className="message__cursor" />}
        </div>
      )}

      <span className="message__meta">
        {m.time}
        {m.tokensPerSecond !== undefined && <span className="message__meta-part">{m.tokensPerSecond.toFixed(1)} tok/s</span>}
        {m.notice && <span className="message__meta-part">{m.notice}</span>}
        {m.role === "assistant" && m.content && !m.isStreaming && (
          <CopyButton text={maskHome(stripPetState(stripThink(m.content)).trim())} />
        )}
      </span>
    </div>
  );
});

/**
 * 폰 가로 화면 동안 메시지 목록을 내려놓았다(lib/standby) 다시 그릴 때 보던 자리. 위로 올려 읽던 세션만(바닥이면 바닥으로 간다).
 * 가로 동안엔 목록이 가려져(display:none) 내려놓는 순간 위치를 못 읽으니, 굴릴 때마다 적어 둔 값을 쓴다
 */
const keptScroll = new Map<string, { top: number; from: number }>();

function ChatMessages({
  messages,
  isRunning,
  onScrollChange,
  onPickSuggestion,
  keepId,
}: {
  messages: ChatMessage[];
  isRunning: boolean;
  onScrollChange?: (show: boolean, scrollFn: () => void) => void;
  onPickSuggestion?: (text: string) => void;
  /** 다시 그릴 때 보던 자리를 되찾을 세션 */
  keepId?: string;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  // 긴 선택문을 줄여 보인 말풍선 중 원문을 펼친 것.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // 말풍선(MessageItem)이 메모라서 함수가 매번 새로 생기면 다 다시 그린다.
  const toggleExpanded = useCallback((id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    }), []);
  const containerRef = useRef<HTMLDivElement>(null);

  // 긴 대화는 최근 것만 그리고, 맨 위에 닿으면 앞을 더 붙인다. 수백 개를 한 번에 그리면
  // 세션을 열 때 마크다운 해석만으로 멈칫한다. `from` 이 null 이면 "끝에서 PAGE 개" 를 따라간다.
  const [from, setFrom] = useState<number | null>(() => (keepId && keptScroll.get(keepId)?.from) || null);
  const start = from === null || from > messages.length ? Math.max(0, messages.length - MESSAGE_PAGE) : from;
  const shown = start > 0 ? messages.slice(start) : messages;
  // 잘라 그려도 앞 답과 비교해야 하니 전체에서 찾는다.
  const switches = useMemo(() => modelSwitches(messages), [messages]);
  // 그림이 있는 답 → 바로 앞 사용자 말(선물함에 넣을 때 제목이 된다). 잘라 그려도 앞 말은 전체에서 찾는다
  const requests = useMemo(() => {
    const out = new Map<string, string>();
    let last = "";
    for (const x of messages) {
      if (x.role === "user") last = x.content;
      else if (x.images?.length) out.set(x.id, last);
    }
    return out;
  }, [messages]);
  const topRef = useRef<HTMLDivElement>(null);
  /** 앞을 붙이기 직전의 높이·위치. 붙인 뒤 보던 자리를 그대로 두는 데 쓴다. */
  const prepend = useRef<{ height: number; top: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    const top = topRef.current;
    if (!el || !top) return;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      prepend.current = { height: el.scrollHeight, top: el.scrollTop };
      setFrom(Math.max(0, start - MESSAGE_PAGE));
    }, { root: el, rootMargin: "400px 0px 0px 0px" });
    io.observe(top);
    return () => io.disconnect();
  }, [start]);

  // 앞에 붙인 만큼 내려서, 보던 말풍선이 제자리에 있게 한다(WebKit 은 스크롤 고정을 안 해 준다).
  useLayoutEffect(() => {
    const el = containerRef.current;
    const p = prepend.current;
    if (!el || !p) return;
    prepend.current = null;
    el.scrollTop = p.top + (el.scrollHeight - p.height);
  }, [start]);
  const isUserScrolledUp = useRef(false);
  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // 보던 자리 지키기(keptScroll): 그릴 때 되찾고, 내려놓을 때 적는다
  const lastTop = useRef(0);
  const startRef = useRef(start);
  startRef.current = start;
  useLayoutEffect(() => {
    const k = keepId && keptScroll.get(keepId);
    const el = containerRef.current;
    if (k && el) {
      el.scrollTop = k.top;
      lastTop.current = k.top;
      isUserScrolledUp.current = true;
      setShowScrollBtn(true);
    }
    return () => {
      if (!keepId) return;
      if (isUserScrolledUp.current) keptScroll.set(keepId, { top: lastTop.current, from: startRef.current });
      else keptScroll.delete(keepId);
    };
  }, [keepId]);

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
    if (containerRef.current) lastTop.current = containerRef.current.scrollTop;
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
      {start > 0 && <div ref={topRef} className="chat-messages__more" aria-hidden="true" />}
      {shown.map((m) => (
        <React.Fragment key={m.id}>
          {switches.has(m.id) && <div className="message-model-switch">여기부터 {switches.get(m.id)}</div>}
          <MessageItem
            m={m}
            running={isRunning && !!m.isStreaming}
            expanded={expanded.has(m.id)}
            onToggle={toggleExpanded}
            request={requests.get(m.id)}
          />
        </React.Fragment>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

// ── Picture → gift box ────────────────────────────────────────────────────────

/** 채팅 낙서를 액자에 넣어 선물함에(neko/pictureGift). 누르면 잠깐 결과를 보여 주고 원래 글자로 돌아간다 */
function PictureGiftButton({ src, request }: { src: string; request: string }) {
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function put() {
    setBusy(true);
    let msg: string;
    try {
      msg = (await addPictureGift(src, request)).added ? "선물함에 넣었어" : "이미 선물함에 있어";
    } catch (e) {
      msg = e instanceof Error && e.message ? e.message : "못 넣었어";
    }
    setBusy(false);
    setNote(msg);
    setTimeout(() => setNote(null), 2000);
  }
  return (
    <button type="button" className="message__more message__gift" disabled={busy} onClick={put}>
      <Gift size={12} />
      {busy ? "넣는 중…" : note ?? "선물함에 넣기"}
    </button>
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
    <button className="message__copy" onClick={copy} title={copied ? "복사됨" : "복사"} aria-label={copied ? "복사됨" : "복사"}>
      {copied ? <Check size={12} /> : <Copy size={12} />}
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

/** 저장해둔 첨부 JSON 을 되살린다. 깨져 있으면 첨부 없이 글만 보여준다. */
function parseAttachments(raw: string | null | undefined): AttachedFile[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as AttachedFile[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// ── Composer ──────────────────────────────────────────────────────────────────

function Composer({
  onSend,
  onStop,
  onActivity,
  isRunning,
  locked,
  queued,
  onCancelQueued,
  history,
}: {
  onSend: (text: string, files: AttachedFile[]) => void;
  onStop: () => void;
  onActivity: () => void;
  /** 네코가 일하는 중. 입력은 받는다 — 보낸 말은 줄 서 있다가 도구 사이에 읽힌다. */
  isRunning: boolean;
  /** 입력 자체를 막는다(끝말잇기에서 고양이 차례). */
  locked: boolean;
  /** 일하는 사이 보낸, 아직 네코가 못 읽은 말. */
  queued: QueuedMessage[];
  onCancelQueued: (id: string) => void;
  /** 이 세션에서 보냈던 메시지, 오래된 것부터. ↑ 로 되살린다. */
  history: string[];
}) {
  const [value, setValue] = useState("");
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [autoMode, setAutoMode] = useState(isAutoApprove);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // ↑/↓ 로 보던 기록의 위치와, 그전에 쓰고 있던 초안.
  const [histPos, setHistPos] = useState<HistoryPos>(null);
  const draftRef = useRef("");

  function submit() {
    const text = value.trim();
    if ((!text && files.length === 0) || locked) return;
    onActivity();
    onSend(text, files);
    setValue("");
    setFiles([]);
    setHistPos(null);
    draftRef.current = "";
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }

  /**
   * 코드로 값을 바꾼다. 높이와 캐럿은 React 가 DOM 에 반영한 뒤에 잡아야 해서
   * 다음 프레임에 손본다. 캐럿을 끝으로 옮기지 않으면 되살린 문장 한가운데에
   * 커서가 남아 다음 ↓ 가 안 먹는다.
   */
  function replaceValue(next: string) {
    setValue(next);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
      el.selectionStart = el.selectionEnd = el.value.length;
    });
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // 맥은 Enter 로 보낸다(Shift+Enter 줄바꿈). 폰은 키보드 return 이 줄바꿈만 하고 보내기는 전송 버튼으로만(사용자) — 가로채지 않으니
    // 한글 조합 중 return 도 웹뷰가 조합을 끝내고 줄을 바꾼다. 줄이 늘면 handleInput 이 입력창을 키운다
    if (e.key === "Enter" && !e.shiftKey && !IS_PHONE) {
      e.preventDefault();
      submit();
      return;
    }

    // 터미널처럼 ↑/↓ 로 보냈던 메시지를 되살린다. 다만 여러 줄을 쓸 때 커서
    // 이동까지 뺏으면 안 되므로, ↑ 는 캐럿 앞에 줄바꿈이 없을 때(첫 줄)만,
    // ↓ 는 뒤에 없을 때(마지막 줄)만 가로챈다.
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (e.shiftKey || e.metaKey || e.altKey || e.ctrlKey) return;
    const el = e.currentTarget;
    const dir = e.key === "ArrowUp" ? -1 : 1;
    const inWay =
      dir === -1
        ? el.value.slice(0, el.selectionStart).includes("\n")
        : el.value.slice(el.selectionEnd).includes("\n");
    if (inWay) return;

    const step = historyStep(history, histPos, dir, draftRef.current);
    if (!step) return; // 되살릴 게 없다 — 평소대로 커서가 움직인다
    // 기록을 처음 열 때만 초안을 넣어둔다(뒤지는 중엔 덮어쓰면 안 된다).
    if (histPos === null) draftRef.current = value;
    e.preventDefault();
    setHistPos(step.pos);
    replaceValue(step.text);
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onActivity();
    setValue(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? []);
    e.target.value = "";
    void addFiles(selected);
  }

  async function addFiles(selected: File[]) {
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
    if (newFiles.length > 0) appEvents.emit("nekoHint", { kind: "attach" });
  }

  // 창 어디에 떨어뜨려도 첨부한다. 첨부 버튼과 같은 File 이라 처리도 같다.
  // 받지 않은 드롭은 웹뷰가 그 파일로 이동해 버리므로 막는다(tauri.conf 의
  // dragDropEnabled:false 가 있어야 파일이 웹뷰까지 온다).
  const [dragging, setDragging] = useState(false);
  // 임시 보관함 위에서는 보관함이 받는다. 그동안은 "첨부" 안내를 거둔다.
  const [overShelf, setOverShelf] = useState(false);
  useEffect(() => {
    let depth = 0; // dragenter/leave 는 안쪽 요소를 지날 때마다 와서 깊이로 센다
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") ?? false;
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const onShelf = e.target instanceof Element && !!e.target.closest("[data-shelf]");
      setOverShelf(onShelf);
      e.dataTransfer!.dropEffect = locked && !onShelf ? "none" : "copy";
    };
    // 보관함이 받은 드롭은 여기(bubble)까지 안 온다. 끌기 상태는 capture 에서 먼저 푼다.
    const onDropCapture = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = 0;
      setDragging(false);
      setOverShelf(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (locked) return;
      // 폴더는 읽을 내용이 없는 빈 파일로 들어온다. 뺀다.
      const dropped = Array.from(e.dataTransfer!.items)
        .filter((item) => item.kind === "file" && !item.webkitGetAsEntry()?.isDirectory)
        .map((item) => item.getAsFile())
        .filter((file): file is File => !!file);
      if (dropped.length) {
        onActivity();
        void addFiles(dropped);
      }
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDropCapture, true);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("drop", onDropCapture, true);
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
    // addFiles·onActivity 는 매번 새로 만들어지지만 상태는 setter 로만 바꾼다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  function removeAttachedFile(index: number) {
    setFiles((prev) => {
      const removed = prev[index];
      if (removed) removeFile(removed.name);
      return prev.filter((_, i) => i !== index);
    });
  }

  return (
    <div className="composer">
      {/* 입력창은 backdrop-filter 가 있어 fixed 가 그 안에 갇힌다. body 로 내보낸다. */}
      {dragging && !locked && !overShelf &&
        createPortal(<div className="drop-overlay" aria-hidden="true">놓으면 첨부돼</div>, document.body)}
      {queued.length > 0 && (
        <ul className="composer__queue">
          {queued.map((q) => (
            <li key={q.id} className="composer__queued">
              <span className="composer__queued-label">대기 중</span>
              <span className="composer__queued-text">
                {(q.displayText ?? q.userText) || `파일 ${q.files.length}개`}
              </span>
              <button onClick={() => onCancelQueued(q.id)} title="보내지 않기" aria-label="보내지 않기">
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <div className="composer__files">
          <Attachments files={files} onRemove={removeAttachedFile} compact />
        </div>
      )}
      <div className="composer__row">
        <textarea
          ref={textareaRef}
          className="composer__input"
          placeholder={isRunning ? "덧붙일 말 입력…" : IS_PHONE ? "메시지 입력…" : "메시지 입력… (Shift+Enter로 줄바꿈)"}
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          enterKeyHint={IS_PHONE ? "enter" : undefined} /* 폰 키보드 return 키는 줄바꿈 모양(보내기는 버튼) */
          onPaste={(e) => {
            // Finder 에서 복사한 파일과 클립보드 이미지는 files 로 온다. 글만 있으면 그대로 붙인다.
            const pasted = Array.from(e.clipboardData.files);
            if (!pasted.length) return;
            e.preventDefault();
            onActivity();
            void addFiles(pasted);
          }}
          onFocus={onActivity}
          rows={1}
          disabled={locked}
        />
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileChange}
        />
        {/* 켜져 있는 동안은 번개를 채운다. 색만으로 구분하면 놓친다. */}
        <button
          className={`composer__auto ${autoMode ? "composer__auto--on" : ""}`}
          onClick={() => { setAutoApprove(!autoMode); setAutoMode(!autoMode); }}
          aria-pressed={autoMode}
          title={
            autoMode
              ? "오토모드 켜짐 — 확인 없이 실행해. 위험한 명령과 메시지·메일 보내기는 그래도 물어봐. 앱을 끄면 꺼져."
              : "오토모드 — 코드 실행·파일 쓰기를 확인 없이 해"
          }
        >
          <Zap size={14} strokeWidth={2.25} fill={autoMode ? "currentColor" : "none"} />
        </button>
        <button
          className="composer__attach"
          onClick={() => fileInputRef.current?.click()}
          disabled={locked}
          title="파일 첨부"
        >
          <Paperclip size={14} />
        </button>
        {/* 일하는 중에도 쓴 글이 있으면 보내기가 먼저다. 비어 있을 때만 중단을 보인다. */}
        {locked || (isRunning && !value.trim() && files.length === 0) ? (
          <button className="composer__stop" onClick={onStop} onPointerDown={keepFocus} onMouseDown={keepFocus}>
            ■ 중단
          </button>
        ) : (
          <button
            className="composer__send"
            onClick={submit}
            onPointerDown={keepFocus}
            onMouseDown={keepFocus}
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

/**
 * 보내기·중단을 눌러도 입력 칸이 포커스를 잃지 않게 한다. 폰에서는 누르는 순간 입력 칸이 놓여 키보드가 내려가고 화면이
 * 움직여, 손을 뗄 때 누른 자리에 버튼이 없어 안 보내졌다. 보낸 뒤에도 키보드가 그대로 있어 이어 칠 수 있다.
 */
const keepFocus = (e: React.PointerEvent | React.MouseEvent) => e.preventDefault();

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
            <ReactMarkdown remarkPlugins={MD_PLUGINS}>
              {stripThink(summary)}
            </ReactMarkdown>
          </div>
        </div>
      )}
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  const standby = useStandby(); // 폰 가로 화면: 가려진 무거운 화면은 그리지 않는다
  // ── Session list ──────────────────────────────────────────────────────────
  // 세션 상태는 sessionStore 소유. 이름은 그대로라 아래 44개 사용처는 무변경.
  const sessions = useSessionStore((s) => s.sessions);
  const activeId = useSessionStore((s) => s.activeId);
  const setSessions = useSessionStore((s) => s.setSessions);
  const setActiveId = useSessionStore((s) => s.setActiveId);

  // ── Neko ──────────────────────────────────────────────────────────────────
  // 네코 외형·자리는 nekoStore 가 소유한다(NekoSlot·엔진이 구독, SettingsModal 이 변경). 시작 때 DB 값을 읽는다.
  useEffect(() => { void useNekoStore.getState().load(); }, []);
  const nekoName = useSettingsStore(nekoNameOf);

  // ── Model context length (from llama.cpp /props) ─────────────────────────
  const [modelContextLength, setModelContextLength] = useState<number | null>(null);
  /** 시작할 때 활성 프로필에 못 붙었다. 세션 오류와 별개라 따로 들고 있는다. */
  const [connectError, setConnectError] = useState<string | null>(null);
  // 관리형 프로필은 앱이 켜질 때 llama-server 를 띄우는데, 모델을 올리는 동안엔
  // /v1/models 가 503 이다. 한 번만 물으면 "--" 로 굳고 에이전트도 기본값(8192)으로
  // 예산을 짠다. 서버가 답할 때까지 다시 묻고, 주소가 바뀌면(프로필 전환) 처음부터.
  const llmUrl = useSettingsStore((s) => s.llmUrl);
  // Claude 컨텍스트를 설정에서 바꿔도 게이지의 분모가 따라가게.
  const claudeContext = useSettingsStore((s) => s.claudeContext);
  useEffect(() => {
    setModelContextLength(null);
    let alive = true;
    let timer: number | undefined;
    const poll = () => fetchLoadedModel().then((info) => {
      if (!alive) return;
      if (info === null) timer = window.setTimeout(poll, 2000);
      else if (info.context_length) setModelContextLength(info.context_length);
    });
    poll();
    return () => { alive = false; clearTimeout(timer); };
  }, [llmUrl, claudeContext]);
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
  // 요약은 세션 목록(sessionStore, DB)에 있다 — 다른 기기에서 한 요약도 여기로 온다
  const compactSummaries = useMemo(
    () => Object.fromEntries(sessions.flatMap((s) => (s.summary ? [[s.id, s.summary]] : []))) as Record<string, string>,
    [sessions],
  );
  const [summaryExpanded, setSummaryExpanded] = useState(false);

  // Track which sessions have had messages loaded from DB
  const loadedSessionsRef = useRef<Set<string>>(new Set());

  /** fresh: 다른 기기에서 바뀌어 다시 읽는다 — 비었으면(요약·지움) 화면도 비운다 */
  async function loadSessionMessages(sessionId: string, fresh = false) {
    if (loadedSessionsRef.current.has(sessionId)) return;
    loadedSessionsRef.current.add(sessionId);
    try {
      const msgs = await conversationApi.load(sessionId);
      if (msgs.length === 0) {
        if (fresh) setAllMessages((prev) => (prev[sessionId]?.some((m) => m.isStreaming) ? prev : { ...prev, [sessionId]: makeInitialMessages() }));
        return;
      }
      const chatMessages: ChatMessage[] = msgs.map((m) => {
        const meta = parseMeta(m.meta);
        // 예전 저장분은 본문 뒤에 "첨부 파일:" 목록이 붙어 있다. 보낸 모습으로 되돌린다.
        const { content, files } = splitAttachmentSection(m.content, parseAttachments(m.attachments));
        return {
          id: crypto.randomUUID(),
          role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
          content,
          attachments: files,
          time: clock(parseDbTime(m.created_at)),
          steps: meta.steps ?? [],
          thinking: meta.thinking,
          images: meta.images,
          tokensPerSecond: meta.tokensPerSecond,
          notice: meta.notice,
          label: meta.label,
          prompt: meta.prompt,
          compacted: meta.compacted,
          model: meta.model,
          isStreaming: false,
        };
      });
      setAllMessages((prev) => {
        // DB 를 읽는 사이에 이 대화로 질문이 나갔으면, 화면에는 진행 중인 답(생각·도구
        // 로그)이 있고 DB 에는 방금 저장된 질문만 있다. 여기서 덮어쓰면 그 답 칸이
        // 사라져 끝난 답이 갈 곳이 없어진다 — ⌃⇧N 으로 물었을 때 실제로 그랬다.
        if (prev[sessionId]?.some((m) => m.isStreaming)) return prev;
        return { ...prev, [sessionId]: chatMessages };
      });
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
            await invoke("notify_user", {
              title: `📅 ${ev.title}`,
              body: msg,
              sound: true,
            }).catch(() => {});
            // 알림 배너는 놓치기 쉽다. 커서가 있는 화면 테두리도 잠깐 빛낸다.
            invoke("glow_alert").catch(() => {});
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
        const [weatherRaw, todayEvents, openTodos, security] = await Promise.all([
          invoke<string>("weather_get", { location: location || "서울" }).catch(() => null),
          scheduleApi.list("today").catch(() => [] as ScheduleEvent[]),
          todosApi.list().catch(() => [] as Todo[]),
          securityApi.check(true).catch(() => null),
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
        if (security) {
          // 괜찮은 건 한 줄로 끝낸다. 매일 아침 항목을 다 늘어놓으면 이상이 생겨도 눈에 안 띈다.
          const issues = security.checks.filter((c) => !c.ok).map((c) => c.summary);
          if (security.new_autostart.length) {
            issues.push(`새 자동 실행 항목 ${security.new_autostart.map((p) => p.split("/").pop()).join(", ")}`);
          }
          lines.push(issues.length
            ? `🛡 **보안** ${issues.join(" · ")} — "보안 점검해줘" 하면 자세히 알려줄게`
            : "🛡 **보안** 이상 없음");
        }
        lines.push("\n좋은 하루 되세요! 🐱");

        const briefingMsg = {
          id: crypto.randomUUID(),
          role: "assistant" as const,
          content: lines.join("\n"),
          time: clock(),
          steps: [],
          isStreaming: false,
        };

        setAllMessages((prev) => {
          const cur = prev[activeId] ?? [];
          return { ...prev, [activeId]: [briefingMsg, ...cur] };
        });
        void nekoWrites();
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

  // ↑ 로 되살릴 입력 기록. 따로 저장하지 않는다 — 보낸 메시지가 이미 기록이고,
  // 세션을 바꾸면 그 세션의 기록으로 같이 바뀐다.
  const userHistory = useMemo(
    () => activeMessages.filter((m) => m.role === "user" && m.content).map((m) => m.content),
    [activeMessages]
  );

  // ── Agent pool (parallel per-session processing) ──────────────────────
  const pool = useAgentPool();
  const { state: rpgState, dayCount, canFeed, feed, playAction, pet, reward } = useCatRpg();

  const isRunning = pool.isRunning(activeId);
  const error = pool.error(activeId);

  // 네코 감독의 '앱을 쓰는 중'(5분 무활동이면 졸림). 키 입력·클릭·스크롤은 useNekoDirector 가 직접 센다
  const markUserActivity = useCallback(() => { useNekoApp.getState().markActive(); }, []);

  // 에이전트 루프 완료 시 play +5
  const prevIsRunning = useRef(isRunning);
  useEffect(() => {
    if (prevIsRunning.current && !isRunning) {
      reward(5);
    }
    prevIsRunning.current = isRunning;
  }, [isRunning, reward]);

  // 쓰다듬기: 네코를 탭하거나(엔진) 몸 위에서 왔다 갔다 문지르면(NekoSlot·useTrackpadPet) 부른다.
  // 가속도계는 M4에서 root 데몬이 필요해 폐기했다. 상자에서 나오기(3번)는 감독이 센다.
  const handlePet = useCallback(() => {
    pet();
    useNekoApp.getState().notePet();
  }, [pet]);

  // 게임 훅이 주는 감정(예전 triggerActionEmotion) → 네코 감독의 게임 층(표 5.1)
  const nekoGameEmotion = useCallback((emotion: CatEmotion, durationMs?: number) => {
    useNekoApp.getState().setGameEmotion(emotion, durationMs);
  }, []);

  const promptTokens = pool.contextTokens(activeId);
  const displayHunger =
    promptTokens === 0 || modelContextLength == null
      ? 100
      : Math.max(0, Math.round(100 - (promptTokens / modelContextLength) * 100));

  // ── 밥 주기 = 컨텍스트 compact ───────────────────────────────────────────────
  const [isCompacting, setIsCompacting] = useState(false);

  const handleFeed = useCallback(async () => {
    if (isCompacting) return;
    const neko = useNekoApp.getState();

    const msgs = (allMessages[activeId] ?? []).filter(
      (m) => m.role === "user" || m.role === "assistant"
    );

    if (msgs.length < 2) {
      // 요약할 대화 없음 → 그냥 hunger 회복. 네코는 간식 한 번(끝나면 떨기)
      feed();
      neko.setFeeding(true);
      window.setTimeout(() => useNekoApp.getState().setFeeding(false), 1500);
      return;
    }

    setIsCompacting(true);
    neko.setFeeding(true); // 네코: 요약이 끝날 때까지 간식을 먹는다
    try {
      const llmMessages: LlmMessage[] = msgs.map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      const previousSummary = compactSummaries[activeId] || undefined;
      const summary = await summarizeConversation(llmMessages, previousSummary);

      // 요약은 챗버블이 아닌 상단 요약 바에 표시. DB 에 적고 그 세션 메시지를 지운다(다른 기기도 같이)
      await useSessionStore.getState().compact(activeId, summary);
      setSummaryExpanded(false);

      // 대화 메시지는 초기화 (새 시작)
      setAllMessages((prev) => ({ ...prev, [activeId]: makeInitialMessages() }));
      loadedSessionsRef.current.delete(activeId); // 재로드 방지

      pool.clearContextTokens(activeId);
      feed();
    } catch {
      // compact 실패해도 무음 처리
    } finally {
      setIsCompacting(false);
      useNekoApp.getState().setFeeding(false); // 다 먹으면 떨기 + 행복
    }
  }, [isCompacting, allMessages, activeId, feed, setAllMessages, setSummaryExpanded, pool]);

  const wordChain = useWordChainGame(nekoGameEmotion);

  useEffect(() => {
    return appEvents.on("wordchainVerdict", ({ exists }) => {
      // 있는 단어면 이의가 기각된 것뿐이라 게임은 그대로 이어진다.
      if (exists) return;
      reward(Math.min(20, Math.floor(wordChain.turnCount / 2)));
      wordChain.endGame();
    });
  }, [wordChain.endGame, wordChain.turnCount, reward]);

  const injectMessage = useCallback((role: "user" | "assistant", content: string) => {
    const msg = {
      id: crypto.randomUUID(),
      role,
      content,
      time: clock(),
      steps: [] as [],
      isStreaming: false,
    };
    setAllMessages(prev => ({ ...prev, [activeId]: [...(prev[activeId] ?? []), msg] }));
  }, [activeId, setAllMessages]);

  const handleSend = useCallback(async (text: string, files: AttachedFile[]) => {
    useNekoApp.getState().callHome(); // 채팅을 보내면 앱을 쓰는 중이고, 산책 중이면 부른 것이다(서둘러 온다)

    // 네코가 일하는 중이면 줄 세운다(pool 이 한다). 게임 시작 같은 지름길은 건너뛴다 —
    // 답하는 도중에 게임이 열리면 안 된다.
    if (pool.isRunning(activeId)) {
      void pool.sendMessage(activeId, text, files, undefined, compactSummaries[activeId] || undefined);
      return;
    }

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
    // Claude 는 말의 겉모양으로 가르지 않는다 — 하자는 건지 묻는 건지 스스로 보고 game.start 를 부른다.
    // 키워드 표는 작은 모델이 게임을 채팅으로 흉내내서 생긴 보조 바퀴다.
    if (!midGame && !isClaudeActive()) {
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

  // ── 다른 기기에서 온 메시지·요약·지움 ─────────────────────────────────────
  // 바뀐 세션은 캐시를 버리고, 열린 세션이면 다시 읽는다. 답을 쓰는 중인 세션은 건드리지 않는다
  useEffect(() => {
    const un = listen<SyncChanged>(SYNC_CHANGED, ({ payload }) => {
      const active = useSessionStore.getState().activeId;
      for (const id of payload.sessions) {
        if (useMessageStore.getState().messages[id]?.some((m) => m.isStreaming)) continue;
        loadedSessionsRef.current.delete(id);
        if (id === active) void loadSessionMessages(id, true);
        else setAllMessages((prev) => { const { [id]: _, ...rest } = prev; return rest; });
      }
    });
    return () => { un.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    appEvents.emit("nekoHint", { kind: "newChat" });
  }

  // ── Delete session ────────────────────────────────────────────────────────
  function handleDelete(id: string) {
    // DB 에서 지운다(메시지·요약까지, 다른 기기에서도). 목록에서 빼는 것만으론 DB 를 안 지운다
    removeSession(id).catch(() => {});
    loadedSessionsRef.current.delete(id);
    localStorage.removeItem(`nekodesk_compact_${id}`);

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
  // 앱이 앞으로 올 때 위치를 묻고 다른 기기의 동네를 받는다(지도·날씨, lib/here)
  useEffect(() => watchHere(), []);
  // 맥 창 최소 높이: 위쪽 칸이 안 잘리는 높이 + 거실(lib/windowMin). 폰은 창이 화면이다
  useEffect(() => (IS_PHONE ? undefined : watchWindowMin()), []);
  // 네코의 큰 상태(깨어 있음·자는 중·산책·밥)를 맥·폰이 맞춘다: 가장 최근에 쓴 기기를 따른다(neko/presence)
  useEffect(() => watchPresence(), []);
  // 저장해둔 "항상 허용" 규칙을 메모리에 올린다. 이게 없으면 첫 요청은
  // 이미 승인한 명령에도 확인 창이 뜬다.
  useEffect(() => { loadPermissionRules(); }, []);
  // 사용자가 ~/.nekodesk/skills/ 에 넣어둔 지식을 읽어둔다.
  useEffect(() => { reloadUserSkills(); }, []);

  // ⌃⇧N 빠른 질문 — 입력은 빠른 질문 창이 받고, 여기서 보낸다. 물을 때마다 새 대화를 연다 —
  // 예전엔 한 "빠른 질문" 대화에 쌓아서, 상관없는 앞 질문들이 맥락으로 따라붙었다.
  // 제목은 질문 앞부분이라 사이드바에서 서로 구별된다.
  useEffect(() => {
    const unlisten = listen<QuickAskPayload>(QUICK_ASK_EVENT, ({ payload }) => {
      const { userText, displayText, task } = buildQuickPrompt(payload);
      const head = (displayText ?? userText).replace(/\s+/g, " ").trim().slice(0, 22);
      const session = { ...makeSession(), title: `⚡ ${head || "빠른 질문"}` };
      const quickId = session.id;
      // 갓 만든 대화라 DB 에 읽을 게 없다 — 전환하며 도는 불러오기가 보낸 질문과 엇갈리지 않게 건너뛴다.
      loadedSessionsRef.current.add(quickId);
      setSessions((prev) => [session, ...prev]);
      setAllMessages((prev) => ({ ...prev, [session.id]: makeInitialMessages() }));
      // 창을 열었을 때 답이 바로 보이게. 사용자는 지금 다른 앱에 있다.
      setActiveId(quickId);
      const files: AttachedFile[] = payload.image
        ? [{ name: "화면 캡처.jpg", content: "", dataUrl: payload.image, size: payload.image.length, type: "image/jpeg" }]
        : [];
      void pool.sendMessage(quickId, userText, files, displayText, undefined, undefined, task);
    });
    return () => { unlisten.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool]);

  // 앱을 켜면 목록 맨 위 프로필(설정에서 꾹 눌러 끌어 정한다)로 연결한다. 로컬 모델이면
  // 서버를 띄우고, 외부 서버면 주소를 맞춘 뒤 살아 있는지 확인한다 — 꺼져 있다는 걸
  // 첫 질문을 던지고 나서야 알게 되면 늦다.
  useEffect(() => {
    const state = loadProfiles();
    const active = state.profiles[0];
    if (!active) return;
    if (state.activeId !== active.id) saveProfiles({ ...state, activeId: active.id });
    activateProfile(active)
      .then(async () => {
        // 관리형은 llama_start 가 즉시 죽었는지 이미 확인했다. 모델 로딩엔 수십 초가
        // 걸리므로 여기서 또 찔러보면 멀쩡한 서버를 죽었다고 오해한다.
        if (active.config) return;
        if ((await probe(profileUrl(active), 3000)) === null) {
          setConnectError(isClaudeProfile(active)
            ? `'${active.name}' 를 쓰려면 Claude API 키가 필요해. 설정 → 모델 프로필에서 넣어줘.`
            : `'${active.name}' 서버에 연결되지 않았어. 설정 → 모델 프로필에서 확인해줘.`);
        }
      })
      .catch((e) => setConnectError(String(e)));
  }, []);

  const [menuOpen, setMenuOpen] = useState(false);
  // 설정을 닫을 때 연결 안내가 떠 있으면 다시 확인한다 — 설정에서 키를 넣었거나(폰은 기기 연결 코드로 키가 온다) 서버를 켰으면 안내를 거둔다.
  useEffect(() => {
    if (menuOpen || !connectError) return;
    const active = loadProfiles().profiles[0];
    if (active && !active.config) void probe(profileUrl(active), 3000).then((alive) => { if (alive !== null) setConnectError(null); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menuOpen]);
  // 닫혀도 퇴장 애니메이션이 끝날 때까지 붙여둔다.
  const [menuMounted, setMenuMounted] = useState(false);
  if (menuOpen && !menuMounted) setMenuMounted(true);
  const [gameSpeech, setGameSpeech] = useState<string | null>(null);
  const game = useDrawingGame(nekoGameEmotion, setGameSpeech, () => reward(10));

  useEffect(() => {
    if (game.phase !== "idle") {
      setSidebarW(400);
    } else {
      setSidebarW(DEFAULT_SIDEBAR_W);
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

  // 타이머가 끝나면 네코가 말풍선으로 알린다(소리 나는 macOS 알림은 카드가 띄운다).
  useEffect(() => {
    return appEvents.on("timerDone", (text) => {
      setGameSpeech(text);
      nekoGameEmotion("happy", 6000);
      // 그사이 그림 게임이 말풍선을 바꿨으면 그건 지우지 않는다.
      setTimeout(() => setGameSpeech((cur) => (cur === text ? null : cur)), 6000);
    });
  }, [nekoGameEmotion]);

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

  // ── 산책 ──────────────────────────────────────────────────────────────────
  // 오래 자리를 비우면 네코가 동네를 한 바퀴 돌고 와서 본 것을 들려준다(Claude 프로필에서만).
  // 경로는 떠날 때 다 정해 저장한다 — 자리는 시각만으로 나와서 껐다 켜도 이어 걷는다(lib/walk).
  const [walk, setWalk] = useState<Walk | null>(null);
  const [away, setAway] = useState(false);
  // 기기들이 같이 보는 마지막 산책(동기화). 다른 기기가 나가 있으면 여기 네코도 자리에 없고, 이 기기는 안 나간다
  const [shared, setShared] = useState<SharedWalk | null>(null);
  const [elsewhere, setElsewhere] = useState(false);
  // 다른 기기가 나간 산책의 길(neko_walk_view). 그 기기가 나가고 서둘러 오고 돌아올 때마다 적는다
  const [viewWalk, setViewWalk] = useState<Walk | null>(null);
  useEffect(() => {
    const read = () => void syncApi.walkShared().then(setShared).catch(() => {});
    const readView = () => void settingsApi.get(WALK_VIEW_KEY).then((raw) => {
      try { const w = raw ? (JSON.parse(raw) as Walk) : null; setViewWalk(w?.path?.length ? w : null); } catch { /* 깨진 값 */ }
    }).catch(() => {});
    read();
    readView();
    return appEvents.on("syncChanged", ({ colls }) => {
      if (colls.includes("walk")) read();
      if (colls.includes("setting")) readView();
    });
  }, []);
  useEffect(() => {
    const on = walkingElsewhere(shared, Date.now());
    setElsewhere(on);
    if (!on || !shared) return;
    const id = window.setTimeout(() => setElsewhere(false), shared.end - Date.now());
    return () => window.clearTimeout(id);
  }, [shared]);
  /** 자리에 없다: 이 기기가 산책 중이거나 다른 기기에서 산책 중 */
  const gone = away || elsewhere;
  /**
   * 지도에 그릴 산책: 이 기기가 걷는 중이면 그것, 다른 기기가 걷는 중이면 그 기기가 적어 둔 길(아직 안 왔으면 없음),
   * 아니면 둘 중 늦게 나간 것(지난 산책 지도). 다른 기기의 산책은 그리기만 한다.
   */
  const otherWalk = viewWalk && (!walk || walkStart(viewWalk) > walkStart(walk) + 1000) ? viewWalk : null;
  const shownWalk = away ? walk : elsewhere ? (otherWalk && shared && Math.abs(walkStart(otherWalk) - shared.start) < 2000 ? otherWalk : null) : (otherWalk ?? walk);
  // 모니터 화면 자리면 화면 창을 띄운다(산책 중엔 숨긴다)
  useNekoScreen(gone, !!walk?.music);
  const brainRef = useRef<WalkBrain | null>(null);
  // 쉬는지는 네코 감독의 '앱을 쓰는 중'(useNekoApp.lastActiveAt: 입력·클릭·스크롤·밥·놀이)으로 본다.
  // 감독이 재우는 때(SLEEPY_MS)부터 졸고, 다시 쓰면 깬다. 산책 중엔 부를 때(callHome)만 서둘러 온다(neko/walkWatch).
  // 구독으로 봐서 App 은 졸기 시작·깰 때만 다시 그린다.
  const [idle, setIdle] = useState(false);
  // 졸기 시작한 시각과 이번 졸음의 추가 산책 대기(5–20분, 졸 때마다 새로 뽑는다)
  const dozeRef = useRef({ at: Date.now(), extraWait: EXTRA_WAIT_MS[0] });
  const hurryHomeRef = useRef(() => {});
  useEffect(() => watchWalkIdle({
    sleepyMs: SLEEPY_MS,
    onIdle: (on) => {
      if (on) dozeRef.current = { at: Date.now(), extraWait: EXTRA_WAIT_MS[0] + Math.random() * (EXTRA_WAIT_MS[1] - EXTRA_WAIT_MS[0]) };
      // 네코의 마음(docs/neko-mind.md §6.2·6.3): 졸기 시작하면 돌아올 사용자에게 건넬 말과 요즘 기울기를 생각해 두고(2시간에 한 번),
      // 깨면 말풍선으로
      if (on) void restThink({ greet: true }).catch(() => {});
      else void takeGreeting().then((t) => { if (t) { appEvents.emit("nekoSays", t); void nekoWrites(); } }).catch(() => {});
      setIdle(on);
    },
    onCall: () => hurryHomeRef.current(),
  }), []);

  const saveWalk = useCallback((w: Walk) => {
    setWalk(w);
    const raw = JSON.stringify(w);
    settingsApi.set(WALK_KEY, raw).catch(() => {});
    // 다른 기기가 이 산책을 지도에 그리게(neko_walk_view, 동기화되는 설정 — 암호화돼 올라간다). 다른 기기는 그리기만 하고
    // 일지는 이 기기만 쓴다(WALK_KEY 는 이 기기에만)
    settingsApi.set(WALK_VIEW_KEY, raw).catch(() => {});
  }, []);

  // 산책 중에 껐다 켰으면 이어 걷는다. 머리(조사하던 것)는 사라졌으니 새로 붙인다.
  useEffect(() => {
    settingsApi.get(WALK_KEY).then((raw) => {
      const w = raw ? (JSON.parse(raw) as Walk) : null;
      if (!w?.path?.length) return;
      setWalk(w);
      if (w.done) return;
      brainRef.current = startWalkBrain({ places: w.places, here: w.home });
      setAway(Date.now() < walkEnd(w));
    }).catch(() => {});
  }, []);

  // 산책이 출발 전 네코 상태를 가지고 나간다(walk.ts WalkBefore). 졸 땐 활동이 없으니 마지막으로 한 활동을 기억해 둔다
  const nekoCtrl = useNekoController();
  // 꿈(0.1.25): 길게 깊이 잘 때 하루 한두 번 — 무엇을 꿀지는 네코의 마음이 고른다(neko/dream). 산책 중엔 안 꾼다
  const awayRef = useRef(away);
  awayRef.current = away;
  useEffect(() => (nekoCtrl ? watchDreams(nekoCtrl, () => awayRef.current) : undefined), [nekoCtrl]);
  const lastActRef = useRef<string | null>(null);
  useEffect(() => nekoCtrl?.on("activity", (a) => { if (a) lastActRef.current = a; }), [nekoCtrl]);
  const beforeWalk = async (): Promise<WalkBefore> => {
    const music = useNekoApp.getState().outside.music || nekoCtrl?.side === "music" || nekoCtrl?.activity === "music";
    // 곡 제목은 느낌 한 줄로만 바뀌어 쓰인다(검색·보고엔 안 들어간다). osascript 를 띄우니 출발할 때 한 번만
    const track = music ? await invoke<{ title: string; artist: string } | null>("ambient_track").catch(() => null) : null;
    return { activity: nekoCtrl?.activity ?? lastActRef.current, music, track, sleepy: idle, hunger: displayHunger, play: rpgState.play, at: Date.now() };
  };

  // 나갔으면 "출발", 아니면 왜 안 나갔는지 — 개발 빌드 '개발자' 칸의 '바로 보내기' 옆에 그대로 보여 준다.
  const departRef = useRef(async (): Promise<string> => "");
  departRef.current = async () => {
    const midGame =
      (game.phase !== "idle" && game.phase !== "done") ||
      (wordChain.phase !== "idle" && wordChain.phase !== "done");
    if (away) return "이미 산책 중";
    if (elsewhere) return "다른 기기에서 산책 중";
    if (midGame) return "게임 중";
    // 밥 먹는 중(대화 요약·쉴 때 기억 정리): 다 먹고 나서 나간다(아래 효과가 feeding 이 풀리면 다시 잰다)
    if (useNekoApp.getState().feeding) return "밥 먹는 중";
    if (!isClaudeActive()) return "Claude 프로필이 아님";
    const blocked = budgetBlockReason();
    if (blocked) return blocked;
    if (walk && !walk.done) return "지난 산책 보고를 기다리는 중";
    // 정기 산책(아침·점심·저녁)이면 지난 산책 끝나고 1시간, 아니면 3시간(lib/walk nextWalkAt)
    const plan = nextWalkAt({ dozeAt: Date.now(), lastWalk: lastWalkWith(lastWalkOf(walk), shared), extraWait: 0 });
    if (plan.at > Date.now() + 1000) {
      return plan.routine
        ? `다음 산책: ${new Date(plan.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ${routineName(plan.at) ?? ""} 산책`.replace("  ", " ")
        : `다음 산책까지 ${Math.ceil((plan.at - Date.now()) / 60_000)}분`;
    }
    const asked = useNekoApp.getState().lastActiveAt;
    const before = await beforeWalk(); // 나가기 전 상태(위치를 묻는 사이 바뀌지 않게 먼저)
    const home = await hereOnce();
    const found = home ? await mapApi.places({ lat: home.lat, lon: home.lon, radiusM: 800 }).catch(() => []) : [];
    const stops = home ? pickPlaces(home, found) : [];
    let legs: Pt[][] | null = null;
    if (home && stops.length) {
      const way: [number, number][] = [[home.lat, home.lon], ...stops.map((p): [number, number] => [p.lat, p.lon]), [home.lat, home.lon]];
      legs = await Promise.all(way.slice(1).map((to, i) => mapApi.walkRoute({ from: way[i], to })))
        .then((routes) => routes.map((r) => r.map(([lat, lon]) => toMeters(home, lat, lon))))
        .catch(() => null);
    }
    // 위치·길을 묻는 사이(위치만 15초까지 걸린다) 사용자가 돌아왔으면 나가지 않는다.
    if (useNekoApp.getState().lastActiveAt !== asked) return "위치·길을 찾는 사이 사용자가 돌아옴";
    const route = legs ?? fallbackLegs();
    const dwell = route.slice(1).map(() => (2 + Math.random() * 3) * 60_000);
    const w: Walk = { home, onMap: !!legs, places: legs ? stops : found, path: buildPath(route, Date.now(), WALK_MS, dwell), ...(before.music ? { music: true as const } : {}) };
    // 나가기 직전에 서버에 선점한다: 다른 기기가 방금 나갔으면 이 기기는 안 나간다(동기화를 안 쓰거나 오프라인이면 혼자 나간다)
    const claim = await syncApi.walkClaim(walkStart(w), walkEnd(w)).catch(() => null);
    if (claim?.walk) setShared(claim.walk);
    if (claim && !claim.ok) return "다른 기기가 먼저 나감";
    saveWalk(w);
    setAway(true);
    brainRef.current = startWalkBrain({ places: w.places, here: home, before });
    return legs ? "출발" : "출발(지도 없이 대체 경로)";
  };

  // 개발 빌드에서만: 설정 › 고양이 › 개발자 '산책 바로 보내기' — 안 그러면 확인에 15–45분 걸린다
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    useDevTools.setState({ walk: () => departRef.current() });
    return () => useDevTools.setState({ walk: null });
  }, []);

  // 졸고 있으면 정기 산책 시간대(아침 7–9·점심 12–14·저녁 18–20시)엔 바로(지난 산책 끝나고 1시간은 지나서), 아니면 5–20분 더 조용하고
  // 지난 산책 3시간 뒤 나간다(lib/walk nextWalkAt).
  // 그사이 사용자가 돌아오거나 일을 시키면 취소하고, 다시 졸 때 새로 구한다.
  const dozing = idle && !isRunning;
  const eating = useNekoApp((s) => !!s.feeding);
  // 이 기기의 큰 상태. 이 기기가 가장 최근에 쓰였으면 다른 기기가 따른다(바뀔 때만 적는다)
  useEffect(() => { reportBigState(away ? "walk" : eating ? "eat" : idle ? "sleep" : "awake"); }, [away, eating, idle]);
  useEffect(() => {
    if (!dozing || gone || eating || (walk && !walk.done)) return;
    const plan = nextWalkAt({ dozeAt: dozeRef.current.at, now: Date.now(), lastWalk: lastWalkWith(lastWalkOf(walk), shared), extraWait: dozeRef.current.extraWait });
    const id = window.setTimeout(() => void departRef.current(), Math.max(0, plan.at - Date.now()));
    return () => window.clearTimeout(id);
  }, [dozing, gone, eating, walk, shared]);

  // 산책 중에 사용자가 부르면(채팅 보내기 — 0.1.24 부터 이것뿐) 남은 길을 버리고 1–2분 안에 곧장 온다.
  // 머리도 그때까지 알아낸 것으로 정리한다. 다른 기기에서 나간 산책은 이 기기에 away 가 없어 그대로 둔다.
  const hurryingRef = useRef(false);
  hurryHomeRef.current = () => {
    // 이미 2분 안에 오는 중이면(서두르는 중 포함) 그대로 둔다 — 채팅을 보낼 때마다 불린다.
    if (!away || !walk || hurryingRef.current || walkEnd(walk) - Date.now() <= 2 * 60_000) return;
    hurryingRef.current = true;
    brainRef.current?.abort();
    const w = walk;
    const home = w.onMap ? w.home : null;
    // 길 찾기가 금방 답하면 길로, 아니면 직선으로.
    const quick = home
      ? Promise.race([
          mapApi
            .walkRoute({ from: toLatLon(home, positionAt(w.path, Date.now())), to: [home.lat, home.lon] })
            .then((r) => r.map(([lat, lon]) => toMeters(home, lat, lon))),
          new Promise<undefined>((resolve) => setTimeout(resolve, 3000)),
        ]).catch(() => undefined)
      : Promise.resolve(undefined);
    void quick.then((route) => {
      const sooner = { ...w, path: hurryHome(w.path, Date.now(), route) };
      saveWalk(sooner);
      void syncApi.walkEnd(walkStart(sooner), walkEnd(sooner)).catch(() => {}); // 다른 기기도 일찍 돌아온 줄 알게
      hurryingRef.current = false;
    });
  };

  // 다녀오면 산책 일지를 지금 대화에 남긴다. prompt 는 이 대화에서만 쓰는 단기기억이라
  // 답 칸의 prompt 로 넣는다(buildHistory) — 사용자 말로 넣으면 시킨 일로 읽힌다.
  const arrivingRef = useRef<Walk | null>(null);
  useEffect(() => {
    // 보고를 기다리는 중에 다시 걸면 일지가 두 번 붙는다.
    if (!walk || walk.done || arrivingRef.current === walk) return;
    const w = walk;
    const id = window.setTimeout(async () => {
      arrivingRef.current = w;
      setAway(false);
      useNekoNeeds.getState().walked(); // 숨은 게이지: 호기심 가득, 조금 꼬질·지침
      void restThink({ greet: false }).catch(() => {}); // 다녀와서 요즘 기울기(2시간에 한 번, docs/neko-mind.md §6.3)
      const brain = brainRef.current ?? startWalkBrain({ places: w.places, here: w.home });
      brainRef.current = null;
      const report = await nekoWrites(brain.result); // 일지를 쓰는 동안 타이핑(0.1.28)
      const sid = useSessionStore.getState().activeId;
      const prompt = report.prompt || undefined;
      useMessageStore.getState().patch(sid, (prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: report.content, prompt, time: clock(), steps: [], isStreaming: false },
      ]);
      conversationApi.save(sid, "assistant", report.content, undefined, serializeMeta({ prompt })).then(relistSessions).catch(() => {});
      saveWalk({ ...w, done: true, pin: report.gift?.place });
      void syncApi.walkEnd(walkStart(w), walkEnd(w)).catch(() => {});
      playAction();
      nekoGameEmotion("happy", 5000); // 감독의 게임 층: 행복 + 꼬리 떨기
    }, Math.max(0, walkEnd(w) - Date.now()));
    return () => window.clearTimeout(id);
  }, [walk, saveWalk, playAction, nekoGameEmotion]);

  const [showScrollBtn, setShowScrollBtn] = useState(false);
  // 사라지는 애니메이션을 보여주려고 퇴장이 끝날 때까지 붙여둔다.
  const [scrollBtnMounted, setScrollBtnMounted] = useState(false);
  if (showScrollBtn && !scrollBtnMounted) setScrollBtnMounted(true);
  const scrollToBottomRef = useRef<() => void>(() => {});
  /**
   * 입력창(과 확인 배너)은 메시지 위에 떠서 뒤를 흐리게 비춘다. 줄바꿈·첨부로 높이가
   * 바뀌므로 재서 `--dock-h` 로 넘긴다 — 메시지 아래 여백과 스크롤 버튼 위치가 쓴다.
   */
  const dockRef = useCallback((dock: HTMLDivElement | null) => {
    const main = dock?.parentElement;
    if (!dock || !main) return;
    const ro = new ResizeObserver(() => main.style.setProperty("--dock-h", `${dock.offsetHeight}px`));
    ro.observe(dock);
    return () => ro.disconnect();
  }, []);
  const handleScrollChange = useCallback((show: boolean, scrollFn: () => void) => {
    setShowScrollBtn(show);
    scrollToBottomRef.current = scrollFn;
  }, []);
  const { isDark, pref: themePref, cycle: cycleTheme } = useTheme();
  // 네코 감독(설계 docs/neko-p2-director.md): 세션 상태·앱 상황 → 계획 → 스케줄러 → 엔진. 자리는 NekoSlot 두 곳 중 설정에 맞는 곳
  useNekoDirector({ activeId, isDark, needs: { hunger: displayHunger, play: rpgState.play }, onPet: handlePet });
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

  // 폰: 대화 목록(사이드바)은 제목을 눌러 여닫는 덮개다. 대화를 고르면 닫힌다.
  useEffect(() => { if (IS_PHONE) drawer.set(false); }, [activeId]);
  // 폰: 왼쪽 끝에서 밀면 대화 목록, 오른쪽 끝에서 밀면 설정. 장이 손가락을 따라 움직이고 놓을 때 정해진다(lib/phone.ts).
  // 폰: 설정을 열면 키보드를 내린다(키보드가 떠 있으면 설정의 아래쪽이 가리고, 대화 목록 손짓도 막혀 있다)
  useEffect(() => { if (IS_PHONE && menuOpen) dismissKeyboard(); }, [menuOpen]);
  // 폰: 지우기 전에 묻는 대화(id)
  const [askDelete, setAskDelete] = useState<string | null>(null);
  const panelsRef = useRef<Panels>({ sheetOpen: false, setSheet: setMenuOpen });
  panelsRef.current = { sheetOpen: menuOpen, setSheet: setMenuOpen };
  useEffect(() => (IS_PHONE ? bindPanels(() => panelsRef.current) : undefined), []);

  // 예전 버전이 화면 저장소에 남긴 API 키를 키체인으로 옮긴다(한 번이면 끝).
  useEffect(() => {
    migrateLegacySecrets().catch(console.warn);
  }, []);

  // 채팅 위 오로라 빛 다섯 덩이. 캡처 막 가장자리 빛과 같은 방식으로 정한다(lib/aurora.ts): 색은 포인트
  // 색에서 채도·색상을 자리마다 부드럽게 바꾸고, 일렁이는 빠르기·박자도 자리를 따라 물결치듯 달라
  // 이웃끼리는 비슷하고 띠 전체로는 들쭉날쭉하다. 켤 때마다 새로 정한다. CSS 는 .chat-aurora__lobe.
  const auroraLobes = useMemo(() => {
    const tint = auroraTints();
    const pace = wave();
    const lag = wave();
    return AURORA_AT.map(([x, y]) => {
      const { chroma, hue } = tint(x);
      const dur = 3.6 + pace(x) * 3.6;
      return {
        "--x": x,
        "--y": y,
        "--k": chroma,
        "--h": hue,
        "--dur": `${dur.toFixed(2)}s`,
        // 음수로 줘서 처음부터 제각각 다른 박자에 있다.
        "--delay": `${(-lag(x) * dur).toFixed(2)}s`,
        "--swell": (1.15 + lag(x) * 0.2).toFixed(2),
      } as React.CSSProperties;
    });
  }, []);

  // ── ⌘K 커맨드 팔레트 · ⌘N 새 대화 · ⌘, 설정 ─────────────────────────────────
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
      } else if (e.key === ",") {
        // ⌘, : 설정(macOS 앱 관례). 열려 있으면 닫는다
        e.preventDefault();
        setMenuOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ESC: 설정 창이 열려 있으면 닫고, 아니면 일하는 중인 네코를 멈춘다.
  // 명령 팔레트처럼 ESC 를 직접 처리하는 곳은 preventDefault 를 하므로 여기서 건너뛴다.
  // 한글 조합 중의 ESC 는 조합 취소라 건드리지 않는다.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (menuOpen) {
        e.preventDefault();
        setMenuOpen(false);
      } else if (isRunning) {
        e.preventDefault();
        pool.stop(activeId);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen, isRunning, activeId, pool]);

  const paletteCommands = useMemo<Command[]>(() => {
    const base: Command[] = [
      { id: "new", icon: "✍️", label: "새 대화", hint: "⌘N", keywords: "new chat 새대화", run: handleNew },
      { id: "settings", icon: "⚙️", label: "설정 열기", keywords: "settings 설정 환경설정", run: () => setMenuOpen(true) },
      {
        id: "theme",
        icon: { light: "☀️", dark: "🌙", system: "🖥️" }[themePref],
        label: `테마: ${THEME_LABEL[themePref]} → ${THEME_LABEL[THEME_NEXT[themePref]]}`,
        keywords: "theme dark light system 테마 다크 라이트 시스템",
        run: cycleTheme,
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
  }, [themePref, rightPanelVisible, sessions, activeId]);

  return (
    <div className={`app${isDragging ? " app--resizing" : ""}`} style={appStyle}>
      <BootSplash />
      <TitleBar
        sessionTitle={activeSession?.title ?? ""}
        onSettings={() => setMenuOpen(true)}
        themePref={themePref}
        onThemeToggle={cycleTheme}
        rightPanelVisible={rightPanelVisible}
        onToggleRightPanel={() => setRightPanelVisible((v) => !v)}
        onSessions={IS_PHONE ? drawer.toggle : undefined}
      />
      {menuMounted && (
        <MenuModal
          onClose={() => setMenuOpen(false)}
          isDark={isDark}
          leaving={!menuOpen}
          onClosed={() => setMenuMounted(false)}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={paletteCommands}
      />
      {!IS_PHONE && <UpdatePrompt />}
      {IS_PHONE && (
        <AlertDialog.Root open={!!askDelete} onOpenChange={(open) => { if (!open) setAskDelete(null); }}>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="update-overlay">
              <AlertDialog.Content className="update-dialog">
                <AlertDialog.Title className="update-dialog__title">이 대화를 지울까요?</AlertDialog.Title>
                <AlertDialog.Description className="update-dialog__sub">
                  "{sessions.find((s) => s.id === askDelete)?.title ?? ""}" 대화가 다른 기기에서도 지워집니다.
                </AlertDialog.Description>
                <div className="update-dialog__actions">
                  <AlertDialog.Cancel className="update-dialog__btn">취소</AlertDialog.Cancel>
                  <AlertDialog.Action className="update-dialog__btn update-dialog__btn--danger" onClick={() => { if (askDelete) handleDelete(askDelete); }}>
                    지우기
                  </AlertDialog.Action>
                </div>
              </AlertDialog.Content>
            </AlertDialog.Overlay>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      )}
      {IS_PHONE && <PairLinkPrompt />}
      {IS_PHONE && <PhonePanel />}

      {IS_PHONE && <div className="drawer-scrim" onClick={() => drawer.set(false)} aria-hidden="true" />}
      <ErrorBoundary label="사이드바">
      <Sidebar
        onNew={handleNew}
        // 폰: 버튼이 늘 보여 잘못 누르기 쉽다 — 지우기 전에 묻는다(맥은 올려 둔 뒤 0.3초 있어야 나타난다)
        onDelete={IS_PHONE ? setAskDelete : handleDelete}
        isRunning={pool.isRunning}
        gameSpeech={gameSpeech}
        rpg={{
          dayCount,
          hunger: displayHunger,
          play: rpgState.play,
          canFeed,
          feedCountToday: rpgState.feedCountToday,
          isCompacting,
          onFeed: () => { void handleFeed(); },
          onPlay: () => { useNekoApp.getState().play(); launchRandomGame(); }, // 털실·나비 6초 → 게임이 이어받음
          onPet: handlePet,
        }}
        onResizeStart={sidebarVisible ? (e) => startDrag("sidebar", e) : undefined}
        isResizing={isDragging === "sidebar"}
        contextTokens={promptTokens}
        modelContextLength={modelContextLength}
        gameMode={game.phase !== "idle" ? game : null}
        away={gone}
        walk={shownWalk}
        isDark={isDark}
      />
      </ErrorBoundary>

      <main className="main">

        <div className="chat-area">
          {/* 위에서 비껴 드는 빛. reactbits 의 LightRays 를 WebGL 없이 옮긴 것. */}
          <div className="chat-aurora" aria-hidden="true">
            {auroraLobes.map((style, i) => (
              <div key={i} className="chat-aurora__lobe" style={style} />
            ))}
          </div>
          {/* 안내는 채팅 칸 위에 떠 있고, 오로라가 그 위에 비친다. 흐름에 두면 채팅 칸이 밀려 오로라도 같이 내려갔다. */}
          <div className="chat-banners">
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
                    ? `${josa(nekoName, "이/가")} 생각 중...`
                    : "게임 종료"}
                </span>
                <span className="wordchain-banner__turns">{wordChain.turnCount}턴</span>
                {wordChain.phase === "user_turn" && (
                  <button
                    className="wordchain-banner__dispute"
                    onClick={() => {
                      void pool.sendMessage(activeId, wordChain.disputeContext(), [], "이의 제기!", undefined, "game.judge");
                    }}
                    title="방금 나온 단어 검증 요청"
                  >이의 제기</button>
                )}
                <button className="wordchain-banner__close" onClick={() => { wordChain.reset(); }}>✕</button>
              </div>
            )}
          </div>
          {compactSummaries[activeId] && (
            <CompactSummaryBar
              summary={compactSummaries[activeId]}
              expanded={summaryExpanded}
              onToggle={() => setSummaryExpanded((v) => !v)}
            />
          )}

          <ErrorBoundary label="채팅">
            {/* 폰 가로 화면 동안은 내려놓는다(lib/standby) — 그림이 든 말풍선까지 쥐고 있지 않게. 돌아오면 보던 자리로 */}
            {!standby && (
              <ChatMessages
                key={activeId}
                keepId={activeId}
                messages={activeMessages}
                isRunning={isRunning}
                onScrollChange={handleScrollChange}
                onPickSuggestion={(text) => handleSend(text, [])}
              />
            )}
          </ErrorBoundary>

          {/* 메시지 위에 떠 있어야 뒤가 비쳐 블러가 보인다. */}
          {scrollBtnMounted && (
            <button
              className="chat-scroll-btn"
              data-leaving={showScrollBtn ? undefined : ""}
              onAnimationEnd={() => { if (!showScrollBtn) setScrollBtnMounted(false); }}
              onClick={() => scrollToBottomRef.current()}
              title="맨 아래로"
            >
              ↓
            </button>
          )}
        </div>

        <div className="chat-dock" ref={dockRef}>
          {pool.pendingConfirm && pool.pendingConfirm.sessionId === activeId && (
            <ConfirmBanner confirm={pool.pendingConfirm} onResolve={pool.confirmResolve} />
          )}

          {pool.pendingClarify && pool.pendingClarify.sessionId === activeId && (
            <ClarifyBanner clarify={pool.pendingClarify} onAnswer={pool.clarifyResolve} />
          )}

          <Composer
            onSend={handleSend}
            onStop={() => pool.stop(activeId)}
            onActivity={markUserActivity}
            isRunning={isRunning}
            locked={wordChain.phase === "cat_turn"}
            queued={pool.queued(activeId)}
            onCancelQueued={(id) => pool.cancelQueued(activeId, id)}
            history={userHistory}
          />
        </div>
      </main>

      {/* 폰은 오른쪽 패널(할 일·일정·뽀모도로·메모·보관함)을 보이지 않는다 — 가려 둔 채 그리지도 않는다 */}
      {!IS_PHONE && (
        <ErrorBoundary label="패널">
          <RightPanel
            onResizeStart={rightPanelVisible ? (e) => startDrag("right", e) : undefined}
            isResizing={isDragging === "right"}
          />
        </ErrorBoundary>
      )}

      {/* '채팅 바 아래' 네코 자리: 창 맨 아래 한 줄, 사이드바부터 오른쪽 패널 끝까지(.app 셋째 줄).
          채팅 칸 안(.chat-dock)에 두면 대화 폭만큼만 생겼다. --dock-h 는 이제 입력창만 잰다. */}
      <NekoSlot placement="dock" onRubPet={handlePet} away={gone} walk={shownWalk} isDark={isDark} />
    </div>
  );
}

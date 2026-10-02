import React, { useState, useEffect } from "react";
import { execHistoryApi } from "../api/tauri";
import { appEvents } from "../lib/events";
import { X } from "lucide-react";
import { SettingsModal, type SettingsTab } from "./SettingsModal";
import { ErrorBoundary } from "./ErrorBoundary";
import type { ExecHistoryItem } from "../agent/types";
import "./MenuModal.css";

// ── Exec History Panel (탭 내 임베딩용) ──────────────────────────────────────

function relativeTime(dateStr: string): string {
  const d = new Date(dateStr.replace(" ", "T"));
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diff < 60) return "방금";
  if (diff < 3600) return `${Math.floor(diff / 60)}분 전`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}시간 전`;
  return `${Math.floor(diff / 86400)}일 전`;
}

const LANG_LABEL: Record<string, string> = {
  python: "py", python3: "py", shell: "sh", sh: "sh", bash: "sh",
  applescript: "as", osascript: "as",
};
const LANG_COLOR: Record<string, string> = {
  py: "#44aa88", sh: "#4477ff", as: "#ff9900",
};

function ExecHistoryPanel() {
  const [items, setItems] = useState<ExecHistoryItem[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  async function load() {
    try {
      const result = await execHistoryApi.list();
      setItems(result);
    } catch {}
  }

  useEffect(() => {
    load();
    return appEvents.on("coderun", () => load());
  }, []);

  async function clearAll() {
    try {
      await execHistoryApi.clear();
      setItems([]);
      setExpandedId(null);
    } catch {}
  }

  if (items.length === 0) {
    return (
      <div className="menu-empty">
        <span>아직 실행 이력이 없어요.</span>
        <span className="menu-empty__sub">에이전트에게 코드 실행을 요청하면 여기에 쌓여요.</span>
      </div>
    );
  }

  return (
    <div className="menu-hist">
      <ul className="menu-hist__list">
        {items.map((item) => {
          const langKey = LANG_LABEL[item.language] ?? item.language.slice(0, 2);
          const langColor = LANG_COLOR[langKey] ?? "var(--text-muted)";
          const isExpanded = expandedId === item.id;
          const firstLine = item.code.split("\n")[0].slice(0, 48);
          return (
            <li
              key={item.id}
              className={`menu-hist__item ${isExpanded ? "menu-hist__item--open" : ""}`}
              onClick={() => setExpandedId(isExpanded ? null : item.id)}
            >
              <div className="menu-hist__row">
                <span className="menu-hist__lang" style={{ color: langColor }}>{langKey}</span>
                <span className="menu-hist__code">{firstLine}{item.code.length > 48 ? "…" : ""}</span>
                <span className={`menu-hist__exit ${item.exit_code === 0 ? "menu-hist__exit--ok" : "menu-hist__exit--err"}`}>
                  {item.exit_code === 0 ? "✓" : `✕ ${item.exit_code}`}
                </span>
                <span className="menu-hist__time">{relativeTime(item.executed_at)}</span>
              </div>
              {isExpanded && (
                <div className="menu-hist__detail">
                  <pre className="menu-hist__pre menu-hist__pre--code">{item.code}</pre>
                  {item.stdout && <pre className="menu-hist__pre">{item.stdout}</pre>}
                  {item.stderr && <pre className="menu-hist__pre menu-hist__pre--err">{item.stderr}</pre>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <div className="menu-hist__footer">
        <button className="menu-hist__clear" onClick={clearAll}>이력 지우기</button>
      </div>
    </div>
  );
}

// ── Menu Modal ────────────────────────────────────────────────────────────────

type MenuTab = SettingsTab | "history";

const TABS: [MenuTab, string][] = [
  ["neko", "네코"],
  ["model", "모델"],
  ["connect", "연동"],
  ["perm", "권한"],
  ["history", "실행 이력"],
];

interface MenuModalProps {
  onClose: () => void;
  isDark: boolean;
  initialTab?: MenuTab;
  /** 닫히는 중. 퇴장 애니메이션을 틀고, 끝나면 onClosed 로 알린다. */
  leaving?: boolean;
  onClosed?: () => void;
}

export function MenuModal({ onClose, isDark, initialTab = "neko", leaving, onClosed }: MenuModalProps) {
  const [tab, setTab] = useState<MenuTab>(initialTab);

  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="menu-backdrop" data-leaving={leaving ? "" : undefined} onClick={handleBackdrop}>
      <div
        className="menu-modal"
        // 안쪽 요소의 애니메이션도 여기로 올라온다. 퇴장 애니메이션일 때만 뗀다.
        onAnimationEnd={(e) => { if (e.animationName === "menu-slide-out") onClosed?.(); }}
      >
        <div className="menu-modal__header">
          <div className="menu-modal__tabs">
            {TABS.map(([id, label]) => (
              <button
                key={id}
                className={`menu-tab ${tab === id ? "menu-tab--active" : ""}`}
                onClick={() => setTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <button className="menu-modal__close" onClick={onClose}><X size={13} /></button>
        </div>

        {/* 경계를 본문에만 둔다. 패널 전체를 감싸면 오류 화면이 퇴장 애니메이션 없이 떠서
            닫아도 animationend 가 안 와 화면에 남는다. 여기면 틀·닫기 버튼이 살아 있다. */}
        <div className="menu-modal__body">
          <ErrorBoundary label="설정" key={tab}>
            {tab === "history" ? (
              <ExecHistoryPanel />
            ) : (
              <SettingsModal
                asTab
                tab={tab}
                onClose={onClose}
                isDark={isDark}
              />
            )}
          </ErrorBoundary>
        </div>
      </div>
    </div>
  );
}

import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X, Zap, Pencil, Trash2, Settings } from "lucide-react";
import { loadMcpServers as syncMcpRegistry } from "../agent/mcp-registry";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "../agent/llm-client";
import { getStoredAccent, saveAccentHex, deriveAccent } from "../theme-colors";
import "./SettingsModal.css";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpServer {
  id: string;
  name: string;
  url: string;
  transport: "http-sse" | "stdio";
  command: string; // for stdio
  enabled: boolean;
}

// ── Storage helpers ───────────────────────────────────────────────────────────

const LLM_URL_KEY = "nekodesk_llm_url";
const MCP_KEY = "nekodesk_mcp_servers";
const SYSTEM_PROMPT_KEY = "nekodesk_system_prompt";
const DEFAULT_LLM_URL = "http://127.0.0.1:8803";

function loadStoredMcpServers(): McpServer[] {
  try {
    const raw = localStorage.getItem(MCP_KEY);
    return raw ? (JSON.parse(raw) as McpServer[]) : [];
  } catch {
    return [];
  }
}

function saveMcpServers(servers: McpServer[]) {
  localStorage.setItem(MCP_KEY, JSON.stringify(servers));
}

// ── Connection status badge ───────────────────────────────────────────────────

type ConnStatus = "idle" | "checking" | "ok" | "fail";

function StatusDot({ status }: { status: ConnStatus }) {
  const labels: Record<ConnStatus, string> = {
    idle: "미확인",
    checking: "확인 중...",
    ok: "연결됨",
    fail: "연결 실패",
  };
  return (
    <span className={`settings-status settings-status--${status}`}>
      {labels[status]}
    </span>
  );
}

// ── MCP server form (inline) ──────────────────────────────────────────────────

interface McpFormProps {
  initial?: Partial<McpServer>;
  onSave: (s: McpServer) => void;
  onCancel: () => void;
}

function McpServerForm({ initial, onSave, onCancel }: McpFormProps) {
  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<McpServer["transport"]>(
    initial?.transport ?? "http-sse"
  );
  const [url, setUrl] = useState(initial?.url ?? "");
  const [command, setCommand] = useState(initial?.command ?? "");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = transport === "http-sse" ? url.trim() : command.trim();
    if (!ok) return;

    onSave({
      id: initial?.id ?? crypto.randomUUID(),
      name: name.trim(),
      transport,
      url: url.trim(),
      command: command.trim(),
      enabled: initial?.enabled ?? true,
    });
  }

  return (
    <form className="mcp-form" onSubmit={submit}>
      <div className="mcp-form__row">
        <label className="mcp-form__label">이름</label>
        <input
          className="mcp-form__input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="예: 파일 서버"
          autoFocus
        />
      </div>

      <div className="mcp-form__row">
        <label className="mcp-form__label">전송 방식</label>
        <select
          className="mcp-form__select"
          value={transport}
          onChange={(e) => setTransport(e.target.value as McpServer["transport"])}
        >
          <option value="http-sse">HTTP (SSE)</option>
          <option value="stdio">stdio (명령어)</option>
        </select>
      </div>

      {transport === "http-sse" ? (
        <div className="mcp-form__row">
          <label className="mcp-form__label">URL</label>
          <input
            className="mcp-form__input"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://127.0.0.1:3000/sse"
          />
        </div>
      ) : (
        <div className="mcp-form__row">
          <label className="mcp-form__label">명령어</label>
          <input
            className="mcp-form__input"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="npx -y @modelcontextprotocol/server-filesystem /"
          />
        </div>
      )}

      <div className="mcp-form__actions">
        <button type="button" className="mcp-form__btn mcp-form__btn--cancel" onClick={onCancel}>
          취소
        </button>
        <button type="submit" className="mcp-form__btn mcp-form__btn--save">
          저장
        </button>
      </div>
    </form>
  );
}

// ── MCP server row ────────────────────────────────────────────────────────────

interface McpRowProps {
  server: McpServer;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function McpRow({ server, onToggle, onEdit, onDelete }: McpRowProps) {
  const [status, setStatus] = useState<ConnStatus>("idle");

  const check = useCallback(async () => {
    if (server.transport !== "http-sse" || !server.url) return;
    setStatus("checking");
    try {
      const res = await fetch(server.url, { signal: AbortSignal.timeout(3000) });
      setStatus(res.ok || res.status === 405 ? "ok" : "fail");
    } catch {
      setStatus("fail");
    }
  }, [server.url, server.transport]);

  return (
    <div className={`mcp-row ${!server.enabled ? "mcp-row--disabled" : ""}`}>
      <div className="mcp-row__header">
        <label className="mcp-row__toggle">
          <input type="checkbox" checked={server.enabled} onChange={onToggle} />
          <span className="mcp-row__name">{server.name}</span>
        </label>
        <span className="mcp-row__tag">{server.transport}</span>
        <div className="mcp-row__btns">
          {server.transport === "http-sse" && (
            <button className="mcp-row__btn" onClick={check} title="연결 확인"><Zap size={12} /></button>
          )}
          <button className="mcp-row__btn" onClick={onEdit} title="편집"><Pencil size={12} /></button>
          <button className="mcp-row__btn mcp-row__btn--del" onClick={onDelete} title="삭제"><Trash2 size={12} /></button>
        </div>
      </div>
      <div className="mcp-row__detail">
        <span className="mcp-row__url">
          {server.transport === "http-sse" ? server.url : server.command}
        </span>
        {server.transport === "http-sse" && status !== "idle" && (
          <StatusDot status={status} />
        )}
      </div>
    </div>
  );
}

// ── User profile section ──────────────────────────────────────────────────────

const USER_PROFILE_KEY = "nekodesk_user_profile";

const DEFAULT_USER_PROFILE = `이름:
직업:
GitHub: https://github.com/
관심사:
사용 언어/기술:
기타: `;

function UserProfileSection() {
  const [profile, setProfile] = useState(
    () => localStorage.getItem(USER_PROFILE_KEY) ?? DEFAULT_USER_PROFILE
  );
  const [saved, setSaved] = useState(false);

  function save() {
    const val = profile.trim();
    if (val && val !== DEFAULT_USER_PROFILE.trim()) {
      localStorage.setItem(USER_PROFILE_KEY, val);
    } else {
      localStorage.removeItem(USER_PROFILE_KEY);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function reset() {
    localStorage.removeItem(USER_PROFILE_KEY);
    setProfile(DEFAULT_USER_PROFILE);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">사용자 프로필</h3>
      <p className="settings-section__desc">
        나에 대한 정보를 적어두세요. 고양이가 대화할 때 참고해요.
      </p>
      <textarea
        className="settings-textarea"
        value={profile}
        onChange={(e) => setProfile(e.target.value)}
        rows={6}
        spellCheck={false}
      />
      <div className="settings-row settings-row--right">
        <button className="settings-btn settings-btn--ghost" onClick={reset}>초기화</button>
        <button className="settings-btn" onClick={save}>
          {saved ? "저장됨" : "저장"}
        </button>
      </div>
    </section>
  );
}

// ── Settings modal ────────────────────────────────────────────────────────────

interface SettingsModalProps {
  onClose: () => void;
  isDark: boolean;
}

export function SettingsModal({ onClose, isDark }: SettingsModalProps) {
  // Accent color (full hex — hue + saturation + lightness 모두 반영)
  const [accentHex, setAccentHex] = useState(() => getStoredAccent());
  const accentInputRef = useRef<HTMLInputElement | null>(null);

  function handleAccentChange(hex: string) {
    setAccentHex(hex);
    saveAccentHex(hex);
    const { accent, accentDim, accentHover } = deriveAccent(hex, isDark);
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--accent-dim", accentDim);
    document.documentElement.style.setProperty("--accent-hover", accentHover);
  }

  function resetAccent() {
    const defaultHex = "#a78bfa";
    saveAccentHex(defaultHex);
    const { accent, accentDim, accentHover } = deriveAccent(defaultHex, isDark);
    document.documentElement.style.setProperty("--accent", accent);
    document.documentElement.style.setProperty("--accent-dim", accentDim);
    document.documentElement.style.setProperty("--accent-hover", accentHover);
    setAccentHex(defaultHex);
  }

  // LLM
  const [llmUrl, setLlmUrl] = useState(
    () => localStorage.getItem(LLM_URL_KEY) ?? DEFAULT_LLM_URL
  );
  const [llmStatus, setLlmStatus] = useState<ConnStatus>("idle");

  // System prompt
  const [systemPrompt, setSystemPrompt] = useState(
    () => localStorage.getItem(SYSTEM_PROMPT_KEY) ?? DEFAULT_CHAT_SYSTEM_PROMPT
  );
  const [promptSaved, setPromptSaved] = useState(false);

  function saveSystemPrompt() {
    const trimmed = systemPrompt.trim();
    if (trimmed) {
      localStorage.setItem(SYSTEM_PROMPT_KEY, trimmed);
    } else {
      localStorage.removeItem(SYSTEM_PROMPT_KEY);
      setSystemPrompt(DEFAULT_CHAT_SYSTEM_PROMPT);
    }
    setPromptSaved(true);
    setTimeout(() => setPromptSaved(false), 1500);
  }

  function resetSystemPrompt() {
    localStorage.removeItem(SYSTEM_PROMPT_KEY);
    setSystemPrompt(DEFAULT_CHAT_SYSTEM_PROMPT);
    setPromptSaved(true);
    setTimeout(() => setPromptSaved(false), 1500);
  }

  // NewsAPI key
  const [newsApiKey, setNewsApiKey] = useState(
    () => localStorage.getItem("nekodesk_newsapi_key") ?? ""
  );
  const [newsApiSaved, setNewsApiSaved] = useState(false);

  function saveNewsApiKey() {
    const key = newsApiKey.trim();
    if (key) {
      localStorage.setItem("nekodesk_newsapi_key", key);
      invoke("settings_set", { key: "newsapi_key", value: key }).catch(console.warn);
    } else {
      localStorage.removeItem("nekodesk_newsapi_key");
      invoke("settings_set", { key: "newsapi_key", value: "" }).catch(console.warn);
    }
    setNewsApiSaved(true);
    setTimeout(() => setNewsApiSaved(false), 1500);
  }

  // MCP
  const [servers, setServers] = useState<McpServer[]>(loadStoredMcpServers);
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Persist MCP servers on change and reload tool registry
  useEffect(() => {
    saveMcpServers(servers);
    syncMcpRegistry(servers).catch(console.warn);
  }, [servers]);

  function saveLlmUrl() {
    localStorage.setItem(LLM_URL_KEY, llmUrl.trim());
  }

  async function checkLlm() {
    setLlmStatus("checking");
    try {
      const res = await fetch(`${llmUrl.trim()}/health`, { signal: AbortSignal.timeout(3000) });
      setLlmStatus(res.ok ? "ok" : "fail");
    } catch {
      setLlmStatus("fail");
    }
  }

  function addServer(s: McpServer) {
    setServers((prev) => [...prev, s]);
    setAddingNew(false);
  }

  function updateServer(s: McpServer) {
    setServers((prev) => prev.map((x) => (x.id === s.id ? s : x)));
    setEditingId(null);
  }

  function toggleServer(id: string) {
    setServers((prev) => prev.map((x) => x.id === id ? { ...x, enabled: !x.enabled } : x));
  }

  function deleteServer(id: string) {
    setServers((prev) => prev.filter((x) => x.id !== id));
    if (editingId === id) setEditingId(null);
  }

  // Close on backdrop click
  function handleBackdrop(e: React.MouseEvent<HTMLDivElement>) {
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="settings-backdrop" onClick={handleBackdrop}>
      <div className="settings-modal">
        <div className="settings-modal__header">
          <span className="settings-modal__title"><Settings size={13} strokeWidth={2} /> 설정</span>
          <button className="settings-modal__close" onClick={onClose}><X size={13} /></button>
        </div>

        <div className="settings-modal__body">

          {/* ── 포인트 색상 ──────────────────────────────────────── */}
          <section className="settings-section">
            <div className="settings-section__header">
              <h3 className="settings-section__title">포인트 색상</h3>
              <button className="settings-btn settings-btn--ghost" onClick={resetAccent}>초기화</button>
            </div>
            <div className="color-row">
              <span className="color-row__label">강조 색상</span>
              <div
                className="color-row__swatch"
                style={{ background: accentHex }}
                onClick={() => accentInputRef.current?.click()}
              >
                <input
                  ref={accentInputRef}
                  type="color"
                  value={accentHex}
                  onChange={(e) => handleAccentChange(e.target.value)}
                  className="color-row__input"
                />
              </div>
            </div>
          </section>

          {/* ── LLM 서버 ─────────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section__title">LLM 서버</h3>
            <p className="settings-section__desc">
              OpenAI 호환 API 엔드포인트 (llama.cpp, Ollama, LM Studio 등)
            </p>
            <div className="settings-row">
              <input
                className="settings-input"
                value={llmUrl}
                onChange={(e) => setLlmUrl(e.target.value)}
                placeholder={DEFAULT_LLM_URL}
                onBlur={saveLlmUrl}
              />
              <button className="settings-btn" onClick={() => { saveLlmUrl(); checkLlm(); }}>
                확인
              </button>
            </div>
            {llmStatus !== "idle" && (
              <div className="settings-feedback">
                <StatusDot status={llmStatus} />
              </div>
            )}
          </section>

          {/* ── NewsAPI ──────────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section__title">NewsAPI</h3>
            <p className="settings-section__desc">
              뉴스 검색용 API 키 (newsapi.org에서 무료 발급)
            </p>
            <div className="settings-row">
              <input
                className="settings-input"
                type="password"
                value={newsApiKey}
                onChange={(e) => setNewsApiKey(e.target.value)}
                placeholder="API 키 입력"
                onBlur={saveNewsApiKey}
              />
              <button className="settings-btn" onClick={saveNewsApiKey}>
                {newsApiSaved ? "저장됨" : "저장"}
              </button>
            </div>
          </section>

          {/* ── 사용자 프로필 ────────────────────────────────────── */}
          <UserProfileSection />

          {/* ── 시스템 프롬프트 ──────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section__title">시스템 프롬프트</h3>
            <p className="settings-section__desc">
              고양이의 성격과 말투를 직접 설정하세요.
            </p>
            <textarea
              className="settings-textarea"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              rows={6}
              spellCheck={false}
            />
            <div className="settings-row settings-row--right">
              <button className="settings-btn settings-btn--ghost" onClick={resetSystemPrompt}>
                초기화
              </button>
              <button className="settings-btn" onClick={saveSystemPrompt}>
                {promptSaved ? "저장됨" : "저장"}
              </button>
            </div>
          </section>

          {/* ── MCP 서버 ─────────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section__title">macOS 권한 설정</h3>
            <p className="settings-section__desc">
              AppleScript나 파일 접근이 잘 안 될 때 아래에서 권한을 열어주세요.
            </p>
            <div className="perm-grid">
              {[
                {
                  label: "손쉬운 사용",
                  desc: "AppleScript로 다른 앱 제어",
                  url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                },
                {
                  label: "자동화",
                  desc: "AppleScript로 앱에 명령 전달",
                  url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation",
                },
                {
                  label: "전체 디스크 접근",
                  desc: "보호된 파일/폴더 읽기·쓰기",
                  url: "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles",
                },
                {
                  label: "화면 녹화",
                  desc: "스크린샷·화면 캡처 접근",
                  url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                },
              ].map(({ label, desc, url }) => (
                <button
                  key={label}
                  className="perm-btn"
                  onClick={() => invoke("open_url", { url })}
                >
                  <span className="perm-btn__label">{label}</span>
                  <span className="perm-btn__desc">{desc}</span>
                  <span className="perm-btn__arrow">↗</span>
                </button>
              ))}
            </div>
          </section>

          <section className="settings-section">
            <div className="settings-section__header">
              <h3 className="settings-section__title">MCP 서버</h3>
              <button
                className="settings-add-btn"
                onClick={() => { setAddingNew(true); setEditingId(null); }}
                disabled={addingNew}
              >
                + 추가
              </button>
            </div>
            <p className="settings-section__desc">
              Model Context Protocol 서버를 연결해 고양이의 도구를 확장하세요.
            </p>

            {addingNew && (
              <McpServerForm
                onSave={addServer}
                onCancel={() => setAddingNew(false)}
              />
            )}

            {servers.length === 0 && !addingNew && (
              <div className="settings-empty">연결된 MCP 서버가 없습니다.</div>
            )}

            <div className="mcp-list">
              {servers.map((s) =>
                editingId === s.id ? (
                  <McpServerForm
                    key={s.id}
                    initial={s}
                    onSave={updateServer}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <McpRow
                    key={s.id}
                    server={s}
                    onToggle={() => toggleServer(s.id)}
                    onEdit={() => { setEditingId(s.id); setAddingNew(false); }}
                    onDelete={() => deleteServer(s.id)}
                  />
                )
              )}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

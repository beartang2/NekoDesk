import React, { useState, useEffect, useCallback } from "react";
import { X, Zap, Pencil, Trash2, Settings } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { loadMcpServers as syncMcpRegistry } from "../agent/mcp-registry";
import { DEFAULT_CHAT_SYSTEM_PROMPT } from "../agent/llm-client";
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

// ── Settings modal ────────────────────────────────────────────────────────────

interface SettingsModalProps {
  onClose: () => void;
}

export function SettingsModal({ onClose }: SettingsModalProps) {
  // GitHub Token
  const [githubToken, setGithubToken] = useState("");
  const [githubTokenSaved, setGithubTokenSaved] = useState(false);

  useEffect(() => {
    invoke<string | null>("settings_get", { key: "github_token" })
      .then((v) => { if (v) setGithubToken(v); })
      .catch(() => {});
  }, []);

  async function saveGithubToken() {
    await invoke("settings_set", { key: "github_token", value: githubToken.trim() });
    setGithubTokenSaved(true);
    setTimeout(() => setGithubTokenSaved(false), 1500);
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

          {/* ── GitHub Token ─────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section__title">GitHub Token</h3>
            <p className="settings-section__desc">
              GitHub 현황 조회에 사용됩니다. Settings → Developer settings → Personal access tokens에서 발급하세요.
            </p>
            <div className="settings-row">
              <input
                className="settings-input"
                type="password"
                value={githubToken}
                onChange={(e) => setGithubToken(e.target.value)}
                placeholder="ghp_xxxxxxxxxxxx"
                onBlur={saveGithubToken}
              />
              <button className="settings-btn" onClick={saveGithubToken}>
                {githubTokenSaved ? "저장됨" : "저장"}
              </button>
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

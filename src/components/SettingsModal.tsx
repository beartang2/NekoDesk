import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { memoryApi, settingsApi } from "../api/tauri";
import { X, Zap, Pencil, Trash2, Settings } from "lucide-react";
import type { Memory } from "../agent/types";
import {
  loadMcpServers as syncMcpRegistry,
  readMcpServerConfigs,
  writeMcpServerConfigs,
} from "../agent/mcp-registry";
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
  loadGenParams,
  saveGenParams,
  type GenParams,
} from "../agent/llm-client";
import { getStoredAccent, saveAccentHex, deriveAccent } from "../theme-colors";
import { CAT_VARIANTS } from "../cat/spriteData";
import { useCatStore } from "../stores/catStore";
import { useSettingsStore, type ToolMode } from "../stores/settingsStore";
import {
  AUTOSTART_KEY,
  DEFAULT_LLAMA_CONFIG,
  activateProfile,
  loadProfiles,
  modelLabel,
  newId,
  probe,
  profileUrl,
  saveProfiles,
  type LlamaConfig,
  type ModelProfile,
  type ProfileState,
} from "../stores/modelProfiles";
import {
  forgetAlwaysRule,
  listAlwaysRules,
  loadPermissionRules,
} from "../agent/permissions";
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

const SYSTEM_PROMPT_KEY = "nekodesk_system_prompt";

// MCP 서버 설정은 mcp-registry 가 SQLite 에 보관한다(예전 localStorage 값은 거기서
// 한 번 옮겨온다). 저장 위치를 두 곳에서 알면 어긋난다.

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

// ── Model profiles section ────────────────────────────────────────────────────

/** 관리형 프로필의 llama-server 실행 인자 편집기. */
function LlamaConfigFields({
  config,
  models,
  onChange,
}: {
  config: LlamaConfig;
  models: string[];
  onChange: (patch: Partial<LlamaConfig>) => void;
}) {
  const mainModels = models.filter((m) => !m.toLowerCase().includes("mmproj"));
  const mmprojModels = models.filter((m) => m.toLowerCase().includes("mmproj"));

  return (
    <>
      <div className="settings-row" style={{ alignItems: "center" }}>
        <span className="gen-param__label" style={{ width: 52, flexShrink: 0 }}>모델</span>
        <select className="server-select" value={config.model} onChange={(e) => onChange({ model: e.target.value })}>
          <option value="">-- 선택 --</option>
          {mainModels.map((m) => <option key={m} value={m}>{m.split("/").pop()}</option>)}
        </select>
      </div>

      <div className="settings-row" style={{ alignItems: "center" }}>
        <span className="gen-param__label" style={{ width: 52, flexShrink: 0 }}>mmproj</span>
        <select className="server-select" value={config.mmproj} onChange={(e) => onChange({ mmproj: e.target.value })}>
          <option value="">없음</option>
          {mmprojModels.map((m) => <option key={m} value={m}>{m.split("/").pop()}</option>)}
        </select>
      </div>

      <div className="settings-row" style={{ alignItems: "center" }}>
        <span className="gen-param__label" style={{ width: 52, flexShrink: 0 }}>MTP 모델</span>
        <select className="server-select" value={config.model_draft} onChange={(e) => onChange({ model_draft: e.target.value })}>
          <option value="">없음</option>
          {mainModels.map((m) => <option key={m} value={m}>{m.split("/").pop()}</option>)}
        </select>
      </div>

      <div className="gen-params-grid" style={{ marginTop: 4 }}>
        <label className="gen-param">
          <span className="gen-param__label">GPU 레이어</span>
          <input className="gen-param__input" type="number" step="1" min="0"
            value={config.ngl}
            onChange={(e) => onChange({ ngl: parseInt(e.target.value, 10) || 0 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">컨텍스트</span>
          <input className="gen-param__input" type="number" step="512" min="512"
            value={config.context}
            onChange={(e) => onChange({ context: parseInt(e.target.value, 10) || 2048 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">포트</span>
          <input className="gen-param__input" type="number" step="1" min="1024"
            value={config.port}
            onChange={(e) => onChange({ port: parseInt(e.target.value, 10) || 8803 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">호스트</span>
          <input className="gen-param__input" type="text"
            value={config.host}
            onChange={(e) => onChange({ host: e.target.value })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Temperature</span>
          <input className="gen-param__input" type="number" step="0.05" min="0" max="2"
            value={config.temp}
            onChange={(e) => onChange({ temp: parseFloat(e.target.value) || 1.0 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Top-K</span>
          <input className="gen-param__input" type="number" step="1" min="0"
            value={config.top_k}
            onChange={(e) => onChange({ top_k: parseInt(e.target.value, 10) || 0 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Top-P</span>
          <input className="gen-param__input" type="number" step="0.05" min="0" max="1"
            value={config.top_p}
            onChange={(e) => onChange({ top_p: parseFloat(e.target.value) || 0 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Min-P</span>
          <input className="gen-param__input" type="number" step="0.01" min="0" max="1"
            value={config.min_p}
            onChange={(e) => onChange({ min_p: parseFloat(e.target.value) || 0 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">KV Cache K</span>
          <select className="gen-param__input server-select" value={config.ctk} onChange={(e) => onChange({ ctk: e.target.value })}>
            <option value="q4_0">q4_0</option>
            <option value="q8_0">q8_0</option>
            <option value="f16">f16</option>
          </select>
        </label>
        <label className="gen-param">
          <span className="gen-param__label">KV Cache V</span>
          <select className="gen-param__input server-select" value={config.ctv} onChange={(e) => onChange({ ctv: e.target.value })}>
            <option value="q4_0">q4_0</option>
            <option value="q8_0">q8_0</option>
            <option value="f16">f16</option>
          </select>
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Reasoning</span>
          <select className="gen-param__input server-select" value={config.reasoning} onChange={(e) => onChange({ reasoning: e.target.value })}>
            <option value="off">off</option>
            <option value="on">on</option>
          </select>
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Reasoning Format</span>
          <select className="gen-param__input server-select" value={config.reasoning_format} onChange={(e) => onChange({ reasoning_format: e.target.value })}>
            <option value="none">none</option>
            <option value="deepseek-r1">deepseek-r1</option>
          </select>
        </label>
        <label className="gen-param">
          <span className="gen-param__label">MTP Draft</span>
          <input className="gen-param__input" type="number" step="1" min="0" max="8"
            title="Multi-Token Prediction 드래프트 토큰 수 (0=비활성, 1~4 권장). Qwen3-MTP 등 MTP 모델에서 추론 속도 향상."
            value={config.mtp_n_draft}
            onChange={(e) => onChange({ mtp_n_draft: parseInt(e.target.value, 10) || 0 })} />
        </label>
      </div>

      <div className="server-checkbox-row">
        <label className="server-checkbox-row__item">
          <input type="checkbox" checked={config.flash_attn} onChange={(e) => onChange({ flash_attn: e.target.checked })} />
          <span>Flash Attn</span>
        </label>
        <label className="server-checkbox-row__item">
          <input type="checkbox" checked={config.jinja} onChange={(e) => onChange({ jinja: e.target.checked })} />
          <span>Jinja</span>
        </label>
      </div>
    </>
  );
}

export function ModelProfilesSection() {
  const [state, setState] = useState<ProfileState>(loadProfiles);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<boolean | null>(null);
  const [autostart, setAutostart] = useState(() => localStorage.getItem(AUTOSTART_KEY) === "true");
  // 중지 직후 유예: 포트가 잠깐 살아있어 헬스체크가 "연결됨" 으로 오진하는 것을 막는다.
  const stoppedAtRef = useRef(0);

  const active = state.profiles.find((p) => p.id === state.activeId) ?? null;
  const editing = state.profiles.find((p) => p.id === editingId) ?? null;

  function commit(next: ProfileState) {
    setState(next);
    saveProfiles(next);
  }

  function patchProfile(id: string, patch: Partial<ModelProfile>) {
    commit({ ...state, profiles: state.profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  }

  const scanModels = useCallback(async () => {
    try {
      setModels(await invoke<string[]>("llama_scan_models"));
    } catch (e) {
      console.warn("llama_scan_models failed:", e);
    }
  }, []);

  useEffect(() => { scanModels(); }, [scanModels]);

  // 활성 프로필이 실제로 응답하는지 주기적으로 확인한다. 외부 서버든 앱이 띄운
  // 서버든 판정 방법은 같다 — 그 주소가 OpenAI 호환 응답을 주는가.
  useEffect(() => {
    let cancelled = false;
    const url = active ? profileUrl(active) : null;
    async function check() {
      if (!url) return;
      if (Date.now() - stoppedAtRef.current < 3000) {
        if (!cancelled) setLive(false);
        return;
      }
      const id = await probe(url, 1500);
      if (!cancelled) setLive(id !== null);
    }
    check();
    const t = setInterval(check, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, [active?.id, active && profileUrl(active)]);

  async function connect(p: ModelProfile) {
    setBusyId(p.id);
    setError(null);
    stoppedAtRef.current = 0;
    try {
      const prev = active;
      commit({ ...state, activeId: p.id });
      await activateProfile(p, prev);
      setLive(true);
    } catch (e) {
      setError(String(e));
      setLive(false);
    } finally {
      setBusyId(null);
    }
  }

  async function stopManaged(p: ModelProfile) {
    if (!p.config) return;
    setBusyId(p.id);
    stoppedAtRef.current = Date.now();
    try {
      await invoke("llama_stop", { port: p.config.port });
      setLive(false);
    } catch (e) {
      console.warn("llama_stop failed:", e);
    } finally {
      setBusyId(null);
    }
  }

  function addProfile(kind: "local" | "external") {
    const p: ModelProfile =
      kind === "local"
        ? { id: newId(), name: "새 로컬 모델", url: "", config: { ...DEFAULT_LLAMA_CONFIG } }
        : { id: newId(), name: "새 외부 서버", url: "http://", config: null };
    commit({ ...state, profiles: [...state.profiles, p] });
    setEditingId(p.id);
  }

  function removeProfile(id: string) {
    const profiles = state.profiles.filter((p) => p.id !== id);
    if (!profiles.length) return; // 마지막 하나는 남긴다
    commit({ profiles, activeId: state.activeId === id ? profiles[0].id : state.activeId });
    if (editingId === id) setEditingId(null);
  }

  return (
    <section className="settings-section">
      <div className="settings-section__header">
        <h3 className="settings-section__title">모델 프로필</h3>
        <button className="settings-btn settings-btn--ghost" onClick={scanModels}>모델 새로고침</button>
      </div>
      <p className="settings-section__desc">
        한 번 설정해두고 목록에서 누르면 연결된다. 로컬 모델은 눌렀을 때 앱이 직접 띄우고,
        외부 서버는 이미 떠 있는 OpenAI 호환 엔드포인트에 붙는다.
      </p>

      {error && <div className="server-error" onClick={() => setError(null)}>{error}</div>}

      <div className="profile-list">
        {state.profiles.map((p) => {
          const isActive = p.id === state.activeId;
          return (
            <div key={p.id} className={`profile-row ${isActive ? "profile-row--active" : ""}`}>
              <button className="profile-row__main" onClick={() => connect(p)} disabled={busyId !== null}>
                <span className={`profile-row__dot ${isActive && live ? "profile-row__dot--live" : ""}`} />
                <span className="profile-row__text">
                  <span className="profile-row__name">{p.name}</span>
                  <span className="profile-row__sub">{modelLabel(p)}</span>
                </span>
                <span className="profile-row__state">
                  {busyId === p.id ? "연결 중…" : isActive ? (live ? "연결됨" : "중지됨") : p.config ? "로컬" : "외부"}
                </span>
              </button>
              <div className="mcp-row__btns">
                <button className="mcp-row__btn" title="편집"
                  onClick={() => setEditingId(editingId === p.id ? null : p.id)}>
                  <Pencil size={12} />
                </button>
                <button className="mcp-row__btn mcp-row__btn--del" title="삭제"
                  disabled={state.profiles.length < 2}
                  onClick={() => removeProfile(p.id)}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className="settings-row">
        <button className="settings-btn settings-btn--ghost" onClick={() => addProfile("local")}>+ 로컬 모델</button>
        <button className="settings-btn settings-btn--ghost" onClick={() => addProfile("external")}>+ 외부 서버</button>
      </div>

      {editing && (
        <div className="profile-editor">
          <div className="settings-row" style={{ alignItems: "center" }}>
            <span className="gen-param__label" style={{ width: 52, flexShrink: 0 }}>이름</span>
            <input className="settings-input" value={editing.name}
              onChange={(e) => patchProfile(editing.id, { name: e.target.value })} />
          </div>

          {editing.config ? (
            <>
              <LlamaConfigFields
                config={editing.config}
                models={models}
                onChange={(patch) => patchProfile(editing.id, { config: { ...editing.config!, ...patch } })}
              />
              <div className="settings-row settings-row--right">
                <button className="settings-btn settings-btn--stop"
                  onClick={() => stopManaged(editing)}
                  disabled={busyId !== null || !(editing.id === state.activeId && live)}>
                  중지
                </button>
                <button className="settings-btn settings-btn--start"
                  onClick={() => connect(editing)}
                  disabled={busyId !== null || !editing.config.model}>
                  {busyId === editing.id ? "..." : "실행"}
                </button>
              </div>
            </>
          ) : (
            <div className="settings-row" style={{ alignItems: "center" }}>
              <span className="gen-param__label" style={{ width: 52, flexShrink: 0 }}>주소</span>
              <input className="settings-input" value={editing.url}
                placeholder="http://192.168.0.10:8080"
                onChange={(e) => patchProfile(editing.id, { url: e.target.value })} />
            </div>
          )}
        </div>
      )}

      <div className="server-checkbox-row">
        <label className="server-checkbox-row__item">
          <input type="checkbox" checked={autostart}
            onChange={(e) => {
              setAutostart(e.target.checked);
              localStorage.setItem(AUTOSTART_KEY, String(e.target.checked));
            }} />
          <span>앱 시작 시 활성 프로필 자동 연결</span>
        </label>
      </div>
    </section>
  );
}

// ── Gen params section ────────────────────────────────────────────────────────

function GenParamsSection() {
  const [params, setParams] = useState<GenParams>(loadGenParams);
  const [saved, setSaved] = useState(false);

  function save() {
    saveGenParams(params);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">최대 응답 토큰</h3>
      <div className="gen-params-grid">
        <label className="gen-param">
          <span className="gen-param__label">에이전트</span>
          <input
            className="gen-param__input"
            type="number"
            step="128"
            min="64"
            value={params.max_tokens_agent}
            onChange={(e) => { saveGenParams({ ...params, max_tokens_agent: parseInt(e.target.value, 10) || 2048 }); setParams((p) => ({ ...p, max_tokens_agent: parseInt(e.target.value, 10) || 2048 })); }}
            onBlur={save}
          />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">채팅</span>
          <input
            className="gen-param__input"
            type="number"
            step="128"
            min="64"
            value={params.max_tokens_chat}
            onChange={(e) => { saveGenParams({ ...params, max_tokens_chat: parseInt(e.target.value, 10) || 512 }); setParams((p) => ({ ...p, max_tokens_chat: parseInt(e.target.value, 10) || 512 })); }}
            onBlur={save}
          />
        </label>
      </div>
    </section>
  );
}

// ── Tool calling mode section ─────────────────────────────────────────────────

const TOOL_MODE_LABELS: Record<ToolMode, string> = {
  auto: "자동 (권장)",
  native: "네이티브 강제",
  json: "JSON 강제",
};

function ToolModeSection() {
  const toolMode = useSettingsStore((s) => s.toolMode);
  const degraded = useSettingsStore((s) => s.nativeToolsDegraded);
  const setToolMode = useSettingsStore((s) => s.setToolMode);

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">툴 호출 방식</h3>
      <p className="settings-section__desc">
        네이티브는 서버의 tool_calls 를 쓴다. 한 턴에 여러 툴을 동시에 부를 수 있고
        프롬프트가 짧아진다. <code>--jinja</code> 로 띄운 llama-server 와 툴 템플릿이
        있는 모델이 필요하다. JSON 은 예전 방식으로, 턴당 툴 하나만 부른다.
      </p>
      <div className="settings-row">
        <select
          className="mcp-form__select"
          value={toolMode}
          onChange={(e) => setToolMode(e.target.value as ToolMode)}
        >
          {(Object.keys(TOOL_MODE_LABELS) as ToolMode[]).map((m) => (
            <option key={m} value={m}>
              {TOOL_MODE_LABELS[m]}
            </option>
          ))}
        </select>
      </div>
      {toolMode === "auto" && degraded && (
        <div className="settings-feedback">
          서버가 네이티브 툴 호출을 거부해서 JSON 모드로 돌고 있어요.
          llama-server 를 <code>--jinja</code> 로 다시 띄우면 자동으로 복구돼요.
        </div>
      )}
    </section>
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
      useSettingsStore.getState().setUserProfile(val);
    } else {
      useSettingsStore.getState().setUserProfile(null);
    }
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  function reset() {
    useSettingsStore.getState().setUserProfile(null);
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

// ── Tool approval rules section ───────────────────────────────────────────────

const WRITE_ROOTS_KEY = "fs_write_roots";

/**
 * "항상 허용" 해둔 툴 규칙과 파일 쓰기 루트를 보여주고 지운다.
 *
 * 승인은 쌓이면 잊힌다. 무엇을 열어뒀는지 한 곳에서 볼 수 없으면 "항상 허용" 은
 * 안전한 선택지가 아니다.
 */
function ToolRulesSection() {
  const [rules, setRules] = useState<string[]>([]);
  const [roots, setRoots] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    await loadPermissionRules();
    setRules(listAlwaysRules());
    try {
      const raw = await settingsApi.get(WRITE_ROOTS_KEY);
      setRoots(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setRoots([]);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function removeRule(key: string) {
    await forgetAlwaysRule(key);
    setRules(listAlwaysRules());
  }

  async function removeRoot(dir: string) {
    const next = roots.filter((r) => r !== dir);
    await settingsApi.set(WRITE_ROOTS_KEY, JSON.stringify(next));
    setRoots(next);
  }

  const empty = rules.length === 0 && roots.length === 0;

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">항상 허용한 작업</h3>
      <p className="settings-section__desc">
        확인 창에서 "항상" 을 고른 것들이에요. 지우면 다음부터 다시 물어봐요.
        위험한 명령(rm -rf, sudo 등)은 여기에 담기지 않고 매번 확인해요.
      </p>
      {empty ? (
        <div className="settings-feedback">아직 없어요.</div>
      ) : (
        <div className="rule-list">
          {rules.map((key) => (
            <div className="rule-row" key={key}>
              <code className="rule-row__key">{key}</code>
              <button className="rule-row__remove" onClick={() => removeRule(key)} title="지우기">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {roots.map((dir) => (
            <div className="rule-row" key={`root:${dir}`}>
              <code className="rule-row__key">쓰기 허용: {dir}</code>
              <button className="rule-row__remove" onClick={() => removeRoot(dir)} title="지우기">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Memories section ──────────────────────────────────────────────────────────

const MEMORY_KIND_LABELS: Record<string, string> = {
  fact: "사실",
  preference: "취향",
  project: "진행 중",
  reference: "자료",
};

/**
 * 고양이가 기억해둔 것들. 지우는 수단이 없으면 기억은 무섭기만 하다 — 무엇을
 * 알고 있는지 보이고 지울 수 있어야 한다.
 */
function MemoriesSection() {
  const [memories, setMemories] = useState<Memory[]>([]);

  const refresh = useCallback(async () => {
    try {
      setMemories(await memoryApi.list());
    } catch {
      setMemories([]);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  async function remove(id: number) {
    await memoryApi.delete(id).catch(() => {});
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">고양이가 기억하는 것</h3>
      <p className="settings-section__desc">
        대화하면서 알게 된 것들이에요. 다음 대화에서도 관련된 것만 자동으로 떠올려요.
      </p>
      {memories.length === 0 ? (
        <div className="settings-feedback">아직 기억한 게 없어요.</div>
      ) : (
        <div className="rule-list">
          {memories.map((m) => (
            <div className="rule-row" key={m.id}>
              <span className="memory-row__kind">{MEMORY_KIND_LABELS[m.kind] ?? m.kind}</span>
              <span className="rule-row__key" title={m.content}>{m.content}</span>
              <button className="rule-row__remove" onClick={() => remove(m.id)} title="잊기">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ── Settings modal ────────────────────────────────────────────────────────────

interface SettingsModalProps {
  onClose: () => void;
  isDark: boolean;
  /** true일 때 backdrop/헤더 없이 body 내용만 렌더링 (MenuModal 탭 내 임베딩용) */
  asTab?: boolean;
}

export function SettingsModal({ onClose, isDark, asTab }: SettingsModalProps) {
  // 고양이 외형은 catStore 소유. prop 대신 스토어를 직접 읽고 바꾼다.
  const catVariantId = useCatStore((s) => s.variantId);
  const onCatVariantChange = useCatStore((s) => s.setVariant);
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

  // System prompt
  const [systemPrompt, setSystemPrompt] = useState(
    () => localStorage.getItem(SYSTEM_PROMPT_KEY) ?? DEFAULT_CHAT_SYSTEM_PROMPT
  );
  const [promptSaved, setPromptSaved] = useState(false);

  function saveSystemPrompt() {
    const trimmed = systemPrompt.trim();
    if (trimmed) {
      useSettingsStore.getState().setSystemPrompt(trimmed);
    } else {
      useSettingsStore.getState().setSystemPrompt(null);
      setSystemPrompt(DEFAULT_CHAT_SYSTEM_PROMPT);
    }
    setPromptSaved(true);
    setTimeout(() => setPromptSaved(false), 1500);
  }

  function resetSystemPrompt() {
    useSettingsStore.getState().setSystemPrompt(null);
    setSystemPrompt(DEFAULT_CHAT_SYSTEM_PROMPT);
    setPromptSaved(true);
    setTimeout(() => setPromptSaved(false), 1500);
  }

  // Brave Search API key
  const [braveSearchKey, setBraveSearchKey] = useState(
    () => localStorage.getItem("nekodesk_brave_search_key") ?? ""
  );
  const [braveSearchSaved, setBraveSearchSaved] = useState(false);

  function saveBraveSearchKey() {
    const key = braveSearchKey.trim();
    localStorage.setItem("nekodesk_brave_search_key", key);
    settingsApi.set("brave_search_key", key).catch(console.warn);
    setBraveSearchSaved(true);
    setTimeout(() => setBraveSearchSaved(false), 1500);
  }

  // MCP — 설정은 DB 에 있으므로 비동기로 읽어온다.
  const [servers, setServers] = useState<McpServer[]>([]);
  const [serversLoaded, setServersLoaded] = useState(false);
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    readMcpServerConfigs()
      .then((loaded) => setServers(loaded as McpServer[]))
      .catch(console.warn)
      .finally(() => setServersLoaded(true));
  }, []);

  // Persist MCP servers on change and reload tool registry
  useEffect(() => {
    // 첫 렌더의 빈 배열로 저장된 설정을 덮어쓰면 안 된다.
    if (!serversLoaded) return;
    writeMcpServerConfigs(servers).catch(console.warn);
    syncMcpRegistry(servers).catch(console.warn);
  }, [servers, serversLoaded]);

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

  const body = (
        <div className="settings-modal__body">

          {/* ── 포인트 색상 ──────────────────────────────────────── */}
          <section className="settings-section">
            <div className="settings-section__header">
              <h3 className="settings-section__title">포인트 색상</h3>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div className="color-row__swatch"
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
                <button className="settings-btn settings-btn--ghost" onClick={resetAccent}>초기화</button>
              </div>
            </div>
          </section>

          {/* ── 고양이 색상 ──────────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section__title">고양이 색상</h3>
            <div className="cat-variant-grid">
              {CAT_VARIANTS.map((v) => (
                <button
                  key={v.id}
                  className={`cat-skin-option ${v.id === catVariantId ? "cat-skin-option--active" : ""}`}
                  onClick={() => onCatVariantChange(v.id)}
                >
                  <span className="cat-skin-swatch" style={{ background: v.swatchCss }} />
                  <span>{v.name}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ── 모델 프로필 ──────────────────────────────────────── */}
          <ModelProfilesSection />

          {/* ── 생성 파라미터 ─────────────────────────────────────── */}
          <GenParamsSection />

          {/* ── 툴 호출 방식 ──────────────────────────────────────── */}
          <ToolModeSection />

          {/* ── 항상 허용한 작업 ──────────────────────────────────── */}
          <ToolRulesSection />

          {/* ── 기억 ──────────────────────────────────────────────── */}
          <MemoriesSection />

          {/* ── Brave Search API ─────────────────────────────────── */}
          <section className="settings-section">
            <h3 className="settings-section__title">Brave Search API</h3>
            <p className="settings-section__desc">
              DuckDuckGo 결과가 없을 때 폴백으로 사용. api.search.brave.com에서 무료 발급 (2,000회/월).
            </p>
            <div className="settings-row">
              <input
                className="settings-input"
                type="password"
                value={braveSearchKey}
                onChange={(e) => setBraveSearchKey(e.target.value)}
                placeholder="BSA..."
                onBlur={saveBraveSearchKey}
              />
              <button className="settings-btn" onClick={saveBraveSearchKey}>
                {braveSearchSaved ? "저장됨" : "저장"}
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
            <h3 className="settings-section__title">권한 설정</h3>
            <p className="settings-section__desc">
              아래에서 권한을 설정해주세요.
            </p>
            <div className="perm-grid">
              {[
                {
                  label: "손쉬운 사용",
                  desc: "AppleScript로 다른 앱 제어",
                  url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
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
  );

  if (asTab) return body;

  return (
    <div className="settings-backdrop" onClick={handleBackdrop}>
      <div className="settings-modal">
        <div className="settings-modal__header">
          <span className="settings-modal__title"><Settings size={13} strokeWidth={2} /> 설정</span>
          <button className="settings-modal__close" onClick={onClose}><X size={13} /></button>
        </div>
        {body}
      </div>
    </div>
  );
}

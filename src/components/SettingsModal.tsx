import React, { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { memoryApi, secretsApi, settingsApi } from "../api/tauri";
import {
  X, Zap, Pencil, Trash2, Settings, Plus, RefreshCw, MapPin, Loader2, ChevronRight, ArrowUpRight, Info, Copy,
} from "lucide-react";
import { Accordion, Popover } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import type { Memory } from "../agent/types";
import { Collapse, EASE, IconButton, SavedLabel, Segmented, Select, SwitchRow, Switch, listItem } from "./ui";
import {
  getMcpTools,
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
import { getStoredAccent, saveAccentHex, setAccentVars } from "../theme-colors";
import { CAT_VARIANTS } from "../cat/spriteData";
import { useCatStore } from "../stores/catStore";
import { useSettingsStore, type ImageProvider, type ToolMode } from "../stores/settingsStore";
import { getAllTools, getTool } from "../agent/tool-registry";
import {
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
import { UpdateSection } from "./Update";
import { useBackdropClose } from "../lib/backdrop";
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
        <Segmented
          value={transport}
          onChange={setTransport}
          options={[
            { value: "http-sse", label: "HTTP (SSE)" },
            { value: "stdio", label: "stdio (명령어)" },
          ]}
        />
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
        <Switch checked={server.enabled} onChange={onToggle} label={`${server.name} 켜기`} />
        <span className="mcp-row__name">{server.name}</span>
        <span className="mcp-row__tag">{server.transport}</span>
        <div className="mcp-row__btns">
          {server.transport === "http-sse" && (
            <IconButton label="연결 확인" onClick={check}><Zap size={12} /></IconButton>
          )}
          <IconButton label="편집" onClick={onEdit}><Pencil size={12} /></IconButton>
          <IconButton label="삭제" danger onClick={onDelete}><Trash2 size={12} /></IconButton>
        </div>
      </div>
      <div className="mcp-row__detail">
        <span className="mcp-row__url">
          {server.transport === "http-sse" ? server.url : server.command}
        </span>
        <AnimatePresence>
          {server.transport === "http-sse" && status !== "idle" && (
            <motion.span key="status" initial={{ opacity: 0, x: 4 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={EASE}>
              <StatusDot status={status} />
            </motion.span>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ── Model profiles section ────────────────────────────────────────────────────

/** 관리형 프로필의 llama-server 실행 인자 편집기. */
const KV_OPTIONS = ["q4_0", "q8_0", "f16"].map((v) => ({ value: v, label: v }));

function LlamaConfigFields({
  config,
  models,
  onChange,
}: {
  config: LlamaConfig;
  models: string[];
  onChange: (patch: Partial<LlamaConfig>) => void;
}) {
  const fileOption = (m: string) => ({ value: m, label: m.split("/").pop() ?? m });
  const mainModels = models.filter((m) => !m.toLowerCase().includes("mmproj")).map(fileOption);
  const mmprojModels = models.filter((m) => m.toLowerCase().includes("mmproj")).map(fileOption);

  return (
    <>
      <div className="settings-field">
        <span className="settings-field__label">모델</span>
        <Select value={config.model} onChange={(model) => onChange({ model })}
          placeholder="모델 선택" options={[{ value: "", label: "선택 안 함" }, ...mainModels]} />
      </div>

      <div className="settings-field">
        <span className="settings-field__label">mmproj</span>
        <Select value={config.mmproj} onChange={(mmproj) => onChange({ mmproj })}
          options={[{ value: "", label: "없음" }, ...mmprojModels]} />
      </div>

      <div className="settings-field">
        <span className="settings-field__label">MTP 모델</span>
        <Select value={config.model_draft} onChange={(model_draft) => onChange({ model_draft })}
          options={[{ value: "", label: "없음" }, ...mainModels]} />
      </div>

      <div className="gen-params-grid">
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
        <div className="gen-param">
          <span className="gen-param__label">KV Cache K</span>
          <Segmented value={config.ctk} onChange={(ctk) => onChange({ ctk })} options={KV_OPTIONS} />
        </div>
        <div className="gen-param">
          <span className="gen-param__label">KV Cache V</span>
          <Segmented value={config.ctv} onChange={(ctv) => onChange({ ctv })} options={KV_OPTIONS} />
        </div>
        <div className="gen-param">
          <span className="gen-param__label">Reasoning Format</span>
          <Segmented value={config.reasoning_format} onChange={(reasoning_format) => onChange({ reasoning_format })}
            options={[{ value: "none", label: "none" }, { value: "deepseek-r1", label: "deepseek-r1" }]} />
        </div>
        <label className="gen-param">
          <span className="gen-param__label">Reasoning Budget</span>
          <input className="gen-param__input" type="number" step="64" min="-1"
            title="생각 토큰 상한 (-1=제한 없음, 0=생각 안 함). 넘으면 생각을 끊고 바로 답한다. 생각이 길게 늘어지면 512 정도로."
            value={config.reasoning_budget}
            onChange={(e) => onChange({ reasoning_budget: Number.isNaN(parseInt(e.target.value, 10)) ? -1 : parseInt(e.target.value, 10) })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">MTP Draft</span>
          <input className="gen-param__input" type="number" step="1" min="0" max="8"
            title="Multi-Token Prediction 드래프트 토큰 수 (0=비활성, 1~4 권장). Qwen3-MTP 등 MTP 모델에서 추론 속도 향상."
            value={config.mtp_n_draft}
            onChange={(e) => onChange({ mtp_n_draft: parseInt(e.target.value, 10) || 0 })} />
        </label>
      </div>

      <div className="switch-list">
        <SwitchRow label="Reasoning" checked={config.reasoning === "on"}
          onChange={(on) => onChange({ reasoning: on ? "on" : "off" })} />
        <SwitchRow label="Flash Attn" checked={config.flash_attn} onChange={(flash_attn) => onChange({ flash_attn })} />
        <SwitchRow label="Jinja" checked={config.jinja} onChange={(jinja) => onChange({ jinja })} />
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

  const [scanning, setScanning] = useState(false);
  const scanModels = useCallback(async () => {
    setScanning(true);
    try {
      setModels(await invoke<string[]>("llama_scan_models"));
    } catch (e) {
      console.warn("llama_scan_models failed:", e);
    } finally {
      setScanning(false);
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
        <button className="settings-btn settings-btn--ghost" onClick={scanModels} disabled={scanning}>
          <RefreshCw size={12} className={scanning ? "ui-spin" : undefined} />
          모델 새로고침
        </button>
      </div>
      <p className="settings-section__desc">
        한 번 설정해두고 목록에서 누르면 연결된다. 로컬 모델은 눌렀을 때 앱이 직접 띄우고,
        외부 서버는 이미 떠 있는 OpenAI 호환 엔드포인트에 붙는다.
      </p>

      <Collapse open={!!error}>
        <div className="server-error" onClick={() => setError(null)}>{error}</div>
      </Collapse>

      <div className="profile-list">
        <AnimatePresence mode="popLayout" initial={false}>
          {state.profiles.map((p) => {
            const isActive = p.id === state.activeId;
            return (
              <motion.div key={p.id} {...listItem}
                className={`profile-row ${isActive ? "profile-row--active" : ""} ${editingId === p.id ? "profile-row--editing" : ""}`}>
                <button className="profile-row__main" onClick={() => connect(p)} disabled={busyId !== null}>
                  <span className={`profile-row__dot ${isActive && live ? "profile-row__dot--live" : ""}`} />
                  <span className="profile-row__text">
                    <span className="profile-row__name">{p.name}</span>
                    <span className="profile-row__sub">{modelLabel(p)}</span>
                  </span>
                  <span className="profile-row__state">
                    {busyId === p.id
                      ? <><Loader2 size={11} className="ui-spin" />연결 중</>
                      : isActive ? (live ? "연결됨" : "중지됨") : p.config ? "로컬" : "외부"}
                  </span>
                </button>
                <div className="mcp-row__btns">
                  <IconButton label="편집" onClick={() => setEditingId(editingId === p.id ? null : p.id)}>
                    <Pencil size={12} />
                  </IconButton>
                  <IconButton label="삭제" danger disabled={state.profiles.length < 2} onClick={() => removeProfile(p.id)}>
                    <Trash2 size={12} />
                  </IconButton>
                </div>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

      <div className="settings-row">
        <button className="settings-btn settings-btn--ghost" onClick={() => addProfile("local")}><Plus size={12} />로컬 모델</button>
        <button className="settings-btn settings-btn--ghost" onClick={() => addProfile("external")}><Plus size={12} />외부 서버</button>
      </div>

      <Collapse open={!!editing}>
        {editing && (
          <div className="profile-editor">
            <div className="settings-field">
              <span className="settings-field__label">이름</span>
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
                    {busyId === editing.id ? <Loader2 size={12} className="ui-spin" /> : "실행"}
                  </button>
                </div>
              </>
            ) : (
              <div className="settings-field">
                <span className="settings-field__label">주소</span>
                <input className="settings-input" value={editing.url}
                  placeholder="http://192.168.0.10:8080"
                  onChange={(e) => patchProfile(editing.id, { url: e.target.value })} />
              </div>
            )}
          </div>
        )}
      </Collapse>
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
      <Segmented
        value={toolMode}
        onChange={setToolMode}
        options={(Object.keys(TOOL_MODE_LABELS) as ToolMode[]).map((m) => ({ value: m, label: TOOL_MODE_LABELS[m] }))}
      />
      <Collapse open={toolMode === "auto" && degraded}>
        <div className="settings-feedback">
          서버가 네이티브 툴 호출을 거부해서 JSON 모드로 돌고 있어요.
          llama-server 를 <code>--jinja</code> 로 다시 띄우면 자동으로 복구돼요.
        </div>
      </Collapse>
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
          <SavedLabel saved={saved} />
        </button>
      </div>
    </section>
  );
}

// ── Weather section ───────────────────────────────────────────────────────────

function WeatherSection() {
  const location = useSettingsStore((s) => s.weatherLocation);
  const setLocation = useSettingsStore((s) => s.setWeatherLocation);
  // 글자마다 저장하면 칠 때마다 날씨를 새로 찾는다. 다 치고 나서 쓴다.
  const [draft, setDraft] = useState(location);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // macOS 위치 서비스에 묻는다. 처음 한 번은 권한 창이 뜬다.
  async function fillCurrentLocation() {
    setLocating(true);
    setError(null);
    try {
      const here = await invoke<string>("location_current");
      setDraft(here);
      setLocation(here);
    } catch (e) {
      setError(String(e));
    } finally {
      setLocating(false);
    }
  }

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">날씨</h3>
      <p className="settings-section__desc">
        고양이 왼쪽 위에 지금 날씨를 띄워요. 지역 이름을 적거나 현재 위치를 쓰고, 비우면 숨겨요.
      </p>
      <div className="settings-row">
        <input
          className="settings-input"
          value={draft}
          placeholder="예: Seoul, 부산"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => setLocation(draft.trim())}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
        />
        <button className="settings-btn settings-btn--ghost" onClick={fillCurrentLocation} disabled={locating}>
          {locating ? <Loader2 size={12} className="ui-spin" /> : <MapPin size={12} />}
          {locating ? "찾는 중" : "현재 위치"}
        </button>
      </div>
      <Collapse open={!!error}>
        <div className="server-error" onClick={() => setError(null)}>{error}</div>
      </Collapse>
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
        <div className="settings-empty">아직 없어요.</div>
      ) : (
        <div className="rule-list">
          <AnimatePresence mode="popLayout" initial={false}>
            {rules.map((key) => (
              <motion.div className="rule-row" key={key} {...listItem}>
                <code className="rule-row__key">{key}</code>
                <IconButton label="지우기" danger onClick={() => removeRule(key)}><Trash2 size={12} /></IconButton>
              </motion.div>
            ))}
            {roots.map((dir) => (
              <motion.div className="rule-row" key={`root:${dir}`} {...listItem}>
                <code className="rule-row__key">쓰기 허용: {dir}</code>
                <IconButton label="지우기" danger onClick={() => removeRoot(dir)}><Trash2 size={12} /></IconButton>
              </motion.div>
            ))}
          </AnimatePresence>
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
        <div className="settings-empty">아직 기억한 게 없어요.</div>
      ) : (
        <div className="rule-list">
          <AnimatePresence mode="popLayout" initial={false}>
            {memories.map((m) => (
              <motion.div className="rule-row" key={m.id} {...listItem}>
                <span className="memory-row__kind">{MEMORY_KIND_LABELS[m.kind] ?? m.kind}</span>
                <span className="rule-row__key" title={m.content}>{m.content}</span>
                <IconButton label="잊기" danger onClick={() => remove(m.id)}><Trash2 size={12} /></IconButton>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
    </section>
  );
}

// ── Image generation section ──────────────────────────────────────────────────

/** dev 빌드 전용. 키는 화면에 안 오니 누를 때 키체인에서 꺼내 복사한다(빌드한 앱에선 꺼내 주지 않는다). */
function DevCopy({ secretKey }: { secretKey: string }) {
  if (!import.meta.env.DEV) return null;
  const copy = () =>
    secretsApi.devGet(secretKey).then((v) => (v ? navigator.clipboard.writeText(v) : undefined)).catch(console.warn);
  return <IconButton label="복사" onClick={copy}><Copy size={12} /></IconButton>;
}

/** 진행 중인 키 저장들. 테스트처럼 곧바로 키를 쓰는 일은 이걸 기다린다 — 칸을 벗어나며 저장하는
 *  것과 경주하지 않게. */
const pendingSecretSaves = new Set<Promise<unknown>>();
const flushSecretSaves = () => Promise.allSettled([...pendingSecretSaves]);

/**
 * 키체인에 두는 API 키 입력 칸. 저장된 키는 다시 보여 주지 않는다 — "저장됨" 만 뜨고, 새로 적으면
 * 바꾸고, 지우기로 없앤다. 칸을 벗어나거나 엔터를 치면 저장한다.
 */
function SecretInput({ secretKey, placeholder, onSaved }: { secretKey: string; placeholder?: string; onSaved?: () => void }) {
  const [has, setHas] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    secretsApi.has(secretKey).then(setHas).catch(() => setHas(false));
  }, [secretKey]);

  function save() {
    const value = draft.trim();
    if (!value) return;
    const saving = secretsApi.set(secretKey, value).then(() => {
      setDraft("");
      setHas(true);
      onSaved?.();
    });
    pendingSecretSaves.add(saving);
    saving.catch(console.warn).finally(() => pendingSecretSaves.delete(saving));
  }

  function clear() {
    secretsApi.set(secretKey, "").then(() => setHas(false)).catch(console.warn);
  }

  return (
    <>
      <input className="settings-input" type="password" value={draft}
        placeholder={has ? "저장됨 · 바꾸려면 새로 입력" : placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
      {has && <DevCopy secretKey={secretKey} />}
      {has && <button className="settings-btn settings-btn--ghost" onClick={clear}>지우기</button>}
    </>
  );
}

const CF_IMAGE_MODELS = [
  "@cf/black-forest-labs/flux-1-schnell",
  "@cf/bytedance/stable-diffusion-xl-lightning",
  "@cf/lykon/dreamshaper-8-lcm",
  "@cf/stabilityai/stable-diffusion-xl-base-1.0",
];
const GOOGLE_IMAGE_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-3.1-flash-lite-image",
  "gemini-3-pro-image",
  "gemini-2.5-flash-image",
];

/** 네코가 그림을 그릴 때 쓰는 서비스. 토큰·키는 키체인에 두고 백엔드만 읽는다(계정 ID 는 DB). */
function ImageGenSection() {
  const imageGen = useSettingsStore((s) => s.imageGen);
  const setImageGen = useSettingsStore((s) => s.setImageGen);
  const [accountId, setAccountId] = useState("");
  const [test, setTest] = useState<{ busy?: boolean; url?: string; error?: string }>({});

  useEffect(() => {
    settingsApi.get("cf_account_id").then((v) => setAccountId(v ?? "")).catch(() => {});
  }, []);

  function saveAccountId() {
    return settingsApi.set("cf_account_id", accountId.trim());
  }

  async function runTest() {
    setTest({ busy: true });
    try {
      // 칸을 벗어나며 시작한 저장과 경주하지 않게, 지금 값을 먼저 써 두고 키 저장도 기다린다.
      await Promise.all([saveAccountId(), flushSecretSaves()]);
      // 에이전트가 쓰는 길을 그대로 탄다.
      const res = await getTool("image.generate").execute({ prompt: "a cute pixel art cat sitting on a desk" });
      setTest({ url: (res as { image_data_url: string }).image_data_url });
    } catch (e) {
      setTest({ error: String(e) });
    }
  }

  const secretRow = (k: string, label: string) => (
    <div className="settings-field">
      <span className="settings-field__label">{label}</span>
      <SecretInput secretKey={k} />
    </div>
  );

  const modelRow = (field: "cfModel" | "googleModel", options: string[]) => (
    <div className="settings-field">
      <span className="settings-field__label">모델</span>
      <input className="settings-input" list={`${field}-options`} value={imageGen[field]}
        onChange={(e) => setImageGen({ ...imageGen, [field]: e.target.value })} />
      <datalist id={`${field}-options`}>
        {options.map((m) => <option key={m} value={m} />)}
      </datalist>
    </div>
  );

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">이미지 생성</h3>
      <p className="settings-section__desc">
        네코가 그림을 그릴 때 쓰는 서비스예요. Cloudflare Workers AI 는 하루 10,000 뉴런까지 무료
        (대시보드의 계정 ID + Workers AI 권한 토큰). Google 은 AI Studio 의 Gemini API 키를 쓰고
        모델에 따라 요금이 나와요.
      </p>
      <Segmented<ImageProvider>
        value={imageGen.provider}
        onChange={(provider) => { setImageGen({ ...imageGen, provider }); setTest({}); }}
        options={[
          { value: "off", label: "끄기" },
          { value: "cloudflare", label: "Cloudflare" },
          { value: "google", label: "Google Gemini" },
        ]}
      />
      <Collapse open={imageGen.provider === "cloudflare"}>
        <div className="settings-field">
          <span className="settings-field__label">계정 ID</span>
          <input className="settings-input" value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            onBlur={() => saveAccountId().catch(console.warn)} />
        </div>
        {secretRow("cf_api_token", "API 토큰")}
        {modelRow("cfModel", CF_IMAGE_MODELS)}
      </Collapse>
      <Collapse open={imageGen.provider === "google"}>
        {secretRow("google_api_key", "API 키")}
        {modelRow("googleModel", GOOGLE_IMAGE_MODELS)}
      </Collapse>
      <Collapse open={imageGen.provider !== "off"}>
        <div className="settings-row settings-row--right">
          <button className="settings-btn" onClick={runTest} disabled={test.busy}>
            {test.busy && <Loader2 size={12} className="ui-spin" />}
            {test.busy ? "그리는 중" : "테스트"}
          </button>
        </div>
      </Collapse>
      <Collapse open={!!test.error}>
        <div className="server-error" onClick={() => setTest({})}>{test.error}</div>
      </Collapse>
      <Collapse open={!!test.url}>
        <img src={test.url} alt="고양이 테스트 그림" className="image-test" />
      </Collapse>
    </section>
  );
}

// ── MCP servers section ───────────────────────────────────────────────────────

function McpSection() {
  // 설정은 DB 에 있으므로 비동기로 읽어온다.
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [addingNew, setAddingNew] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    readMcpServerConfigs()
      .then((list) => setServers(list as McpServer[]))
      .catch(console.warn)
      .finally(() => setLoaded(true));
  }, []);

  // 바꿀 때만 저장하고 다시 붙는다. 열 때마다 동기화하면 stdio 서버가 매번 재시작된다
  // (앱 시작 시 로드는 initMcpFromStorage 가 한다).
  function commit(next: McpServer[]) {
    setServers(next);
    writeMcpServerConfigs(next).catch(console.warn);
    syncMcpRegistry(next).catch(console.warn);
  }

  function addServer(s: McpServer) {
    commit([...servers, s]);
    setAddingNew(false);
  }

  function updateServer(s: McpServer) {
    commit(servers.map((x) => (x.id === s.id ? s : x)));
    setEditingId(null);
  }

  function toggleServer(id: string) {
    commit(servers.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x)));
  }

  function deleteServer(id: string) {
    commit(servers.filter((x) => x.id !== id));
    if (editingId === id) setEditingId(null);
  }

  return (
    <section className="settings-section">
      <div className="settings-section__header">
        <h3 className="settings-section__title">MCP 서버</h3>
        <button
          className="settings-add-btn"
          onClick={() => { setAddingNew(true); setEditingId(null); }}
          disabled={addingNew || !loaded}
        >
          <Plus size={12} />추가
        </button>
      </div>
      <p className="settings-section__desc">
        Model Context Protocol 서버를 연결해 고양이의 도구를 확장하세요.
      </p>

      <Collapse open={addingNew}>
        <McpServerForm
          onSave={addServer}
          onCancel={() => setAddingNew(false)}
        />
      </Collapse>

      {servers.length === 0 && !addingNew && (
        <div className="settings-empty">연결된 MCP 서버가 없습니다.</div>
      )}

      <div className="mcp-list">
        <AnimatePresence mode="popLayout" initial={false}>
          {servers.map((s) => (
            <motion.div key={s.id} {...listItem}>
              {editingId === s.id ? (
                <McpServerForm
                  initial={s}
                  onSave={updateServer}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <McpRow
                  server={s}
                  onToggle={() => toggleServer(s.id)}
                  onEdit={() => { setEditingId(s.id); setAddingNew(false); }}
                  onDelete={() => deleteServer(s.id)}
                />
              )}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

// ── 도구 목록 ─────────────────────────────────────────────────────────────────

// 이름 앞부분(todo.add → todo)으로 묶는다. 표에 없는 새 툴은 유틸리티로 간다.
const TOOL_CATEGORY: Record<string, string> = {
  plan: "빌트인", user: "빌트인", agent: "빌트인", skill: "빌트인", memory: "빌트인",
  fs: "파일·코드", file: "파일·코드", code: "파일·코드", airdrop: "파일·코드",
  web: "웹",
};

interface ToolInfo {
  name: string;
  description: string;
  server?: string;
  params?: {
    properties?: Record<string, { type?: string; description?: string; enum?: string[]; items?: { type: string } }>;
    required?: string[];
  };
}

function ToolsSection() {
  // 모델에게 실제로 보내는 목록과 같은 소스를 읽는다 — 꺼둔 이미지 생성은 여기서도 빠진다.
  const groups = new Map<string, ToolInfo[]>(
    ["빌트인", "파일·코드", "웹", "유틸리티"].map((c) => [c, []])
  );
  for (const t of getAllTools()) {
    groups.get(TOOL_CATEGORY[t.name.split(".")[0]] ?? "유틸리티")!.push(t);
  }
  groups.set("MCP", getMcpTools().map((e) => ({ ...e.tool, server: e.serverName, params: e.tool.inputSchema })));

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">도구</h3>
      <p className="settings-section__desc">네코가 쓸 수 있는 도구입니다. 누르면 설명과 매개변수를 볼 수 있어요.</p>
      <Accordion.Root type="multiple" className="tool-acc">
        {[...groups].map(([category, tools]) => (
          <Accordion.Item key={category} value={category} className="tool-group">
            <Accordion.Header className="tool-group__header">
              <Accordion.Trigger className="tool-group__trigger">
                <ChevronRight size={13} className="tool-group__chevron" />
                {category}
                <span className="tool-group__count">{tools.length}</span>
              </Accordion.Trigger>
            </Accordion.Header>
            <Accordion.Content className="tool-group__content">
              {tools.length === 0 ? (
                <div className="settings-empty tool-group__empty">연결된 MCP 도구가 없습니다. 연동 탭에서 서버를 추가하세요.</div>
              ) : (
                <ul className="tool-group__list">
                  {tools.map((t, i) => (
                    // 펼칠 때 위에서부터 차례로 내려앉는다. 길어도 지연은 12번째에서 멈춘다.
                    <li key={t.name} style={{ "--i": Math.min(i, 12) } as React.CSSProperties}>
                      <ToolRow tool={t} />
                    </li>
                  ))}
                </ul>
              )}
            </Accordion.Content>
          </Accordion.Item>
        ))}
      </Accordion.Root>
    </section>
  );
}

/** 목록엔 이름만. 누르면 설명·매개변수를 행 바로 아래 팝업으로 보여준다. */
function ToolRow({ tool }: { tool: ToolInfo }) {
  const params = Object.entries(tool.params?.properties ?? {});
  const required = new Set(tool.params?.required ?? []);

  return (
    <Popover.Root>
      <Popover.Trigger className="tool-row">
        <span className="tool-row__name">{tool.name}</span>
        {tool.server && <span className="mcp-row__tag">{tool.server}</span>}
        <Info size={12} className="tool-row__icon" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="tool-pop" side="bottom" align="start" sideOffset={4} collisionPadding={12}>
          <div className="tool-pop__head">
            <span className="tool-pop__name">{tool.name}</span>
            {tool.server && <span className="mcp-row__tag">{tool.server}</span>}
            <Popover.Close className="ui-icon-btn tool-pop__close" aria-label="닫기"><X size={12} /></Popover.Close>
          </div>
          <p className="tool-pop__desc">{tool.description || "설명이 없습니다."}</p>

          <div className="tool-pop__label">매개변수</div>
          {params.length === 0 ? (
            <p className="tool-pop__none">없음</p>
          ) : (
            <ul className="tool-pop__params">
              {params.map(([key, p]) => (
                <li key={key} className="tool-param">
                  <div className="tool-param__head">
                    <code className="tool-param__name">{key}</code>
                    <span className="tool-param__type">{p.enum ? p.enum.join(" | ") : p.items ? `${p.items.type}[]` : p.type ?? "any"}</span>
                    {required.has(key) && <span className="tool-param__req">필수</span>}
                  </div>
                  {p.description && <p className="tool-param__desc">{p.description}</p>}
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ── Settings modal ────────────────────────────────────────────────────────────

export type SettingsTab = "neko" | "model" | "connect" | "tools" | "perm";

interface SettingsModalProps {
  onClose: () => void;
  isDark: boolean;
  /** true일 때 backdrop/헤더 없이 body 내용만 렌더링 (MenuModal 탭 내 임베딩용) */
  asTab?: boolean;
  /** 보여줄 묶음. 탭 버튼은 MenuModal 이 그린다. */
  tab?: SettingsTab;
}

export function SettingsModal({ onClose, isDark, asTab, tab = "neko" }: SettingsModalProps) {
  // 고양이 외형은 catStore 소유. prop 대신 스토어를 직접 읽고 바꾼다.
  const catVariantId = useCatStore((s) => s.variantId);
  const onCatVariantChange = useCatStore((s) => s.setVariant);
  // Accent color (full hex — hue + saturation + lightness 모두 반영)
  const [accentHex, setAccentHex] = useState(() => getStoredAccent());
  const accentInputRef = useRef<HTMLInputElement | null>(null);

  function handleAccentChange(hex: string) {
    setAccentHex(hex);
    saveAccentHex(hex);
    setAccentVars(hex, isDark);
  }

  function resetAccent() {
    const defaultHex = "#a78bfa";
    saveAccentHex(defaultHex);
    setAccentVars(defaultHex, isDark);
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

  // Brave Search API key — 키체인에(SecretInput). 저장되면 잠깐 "저장됨".
  const [braveSearchSaved, setBraveSearchSaved] = useState(false);
  function onBraveSaved() {
    setBraveSearchSaved(true);
    setTimeout(() => setBraveSearchSaved(false), 1500);
  }


  // 바탕을 눌러 닫기(누른 곳·뗀 곳 둘 다 바탕일 때만).
  const backdrop = useBackdropClose(onClose);

  const body = (
        <div className="settings-modal__body">
          {tab === "neko" && (
            <>
              {/* ── 포인트 색상 ──────────────────────────────────────── */}
              <section className="settings-section">
                <div className="settings-section__header">
                  <h3 className="settings-section__title">포인트 색상</h3>
                  <div className="settings-inline">
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
                      {/* 고른 테두리가 옆 칸으로 미끄러져 옮겨 간다. */}
                      {v.id === catVariantId && (
                        <motion.span layoutId="cat-skin-ring" className="cat-skin-option__ring" transition={EASE} />
                      )}
                      <span className="cat-skin-swatch" style={{ background: v.swatchCss }} />
                      <span>{v.name}</span>
                    </button>
                  ))}
                </div>
              </section>

              {/* ── 날씨 ──────────────────────────────────────────────── */}
              <WeatherSection />

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
                    <SavedLabel saved={promptSaved} />
                  </button>
                </div>
              </section>

              {/* ── 기억 ──────────────────────────────────────────────── */}
              <MemoriesSection />
            </>
          )}
          {tab === "model" && (
            <>
              {/* ── 모델 프로필 ──────────────────────────────────────── */}
              <ModelProfilesSection />

              {/* ── 생성 파라미터 ─────────────────────────────────────── */}
              <GenParamsSection />

              {/* ── 툴 호출 방식 ──────────────────────────────────────── */}
              <ToolModeSection />
            </>
          )}
          {tab === "connect" && (
            <>
              {/* ── 이미지 생성 ──────────────────────────────────────── */}
              <ImageGenSection />

              {/* ── Brave Search API ─────────────────────────────────── */}
              <section className="settings-section">
                <h3 className="settings-section__title">Brave Search API</h3>
                <p className="settings-section__desc">
                  DuckDuckGo 결과가 없을 때 폴백으로 사용. api.search.brave.com에서 무료 발급 (2,000회/월).
                </p>
                <div className="settings-row">
                  <SecretInput secretKey="brave_search_key" placeholder="BSA..." onSaved={onBraveSaved} />
                  {braveSearchSaved && <SavedLabel saved />}
                </div>
              </section>

              {/* ── MCP 서버 ─────────────────────────────────────────── */}
              <McpSection />
            </>
          )}
          {tab === "tools" && <ToolsSection />}
          {tab === "perm" && (
            <>
              <UpdateSection />

              {/* ── 항상 허용한 작업 ──────────────────────────────────── */}
              <ToolRulesSection />

              {/* ── 권한 설정 ─────────────────────────────────────────── */}
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
                      <ArrowUpRight size={12} className="perm-btn__arrow" />
                    </button>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
  );

  if (asTab) return body;

  return (
    <div className="settings-backdrop" {...backdrop}>
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

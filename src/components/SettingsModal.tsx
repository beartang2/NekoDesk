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

const LLM_URL_KEY = "nekodesk_llm_url";
const SYSTEM_PROMPT_KEY = "nekodesk_system_prompt";
const DEFAULT_LLM_URL = "http://127.0.0.1:8803";

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

// ── llama-server section ──────────────────────────────────────────────────────

const LLAMA_CONFIG_KEY = "nekodesk_llama_config";
const LLAMA_AUTOSTART_KEY = "nekodesk_llama_autostart";

interface LlamaConfig {
  model: string;
  mmproj: string;
  model_draft: string;
  ngl: number;
  flash_attn: boolean;
  jinja: boolean;
  ctk: string;
  ctv: string;
  context: number;
  temp: number;
  top_k: number;
  top_p: number;
  min_p: number;
  port: number;
  host: string;
  reasoning: string;
  reasoning_format: string;
  mtp_n_draft: number;
}

const DEFAULT_LLAMA_CONFIG: LlamaConfig = {
  model: "",
  mmproj: "",
  model_draft: "",
  ngl: 99,
  flash_attn: true,
  jinja: true,
  ctk: "q4_0",
  ctv: "q4_0",
  context: 8192,
  temp: 1.0,
  top_k: 64,
  top_p: 0.95,
  min_p: 0.0,
  port: 8803,
  host: "127.0.0.1",
  reasoning: "off",
  reasoning_format: "none",
  mtp_n_draft: 0,
};

function loadLlamaConfig(): LlamaConfig {
  try {
    const raw = localStorage.getItem(LLAMA_CONFIG_KEY);
    const saved = raw ? { ...DEFAULT_LLAMA_CONFIG, ...JSON.parse(raw) } : { ...DEFAULT_LLAMA_CONFIG };
    // 예전 기본값 0.0.0.0 은 llama-server 를 모든 네트워크 인터페이스에 연다.
    // 같은 와이파이의 누구나 인증 없이 모델을 쓸 수 있다는 뜻이고, 앱 자신은
    // 127.0.0.1 로만 접속하므로 얻는 것도 없다. 저장된 값도 되돌린다 —
    // 정말 LAN 에 열고 싶으면 다시 입력하면 된다.
    if (saved.host === "0.0.0.0") saved.host = "127.0.0.1";
    return saved;
  } catch {
    return { ...DEFAULT_LLAMA_CONFIG };
  }
}

function LlamaServerSection() {
  const [config, setConfig] = useState<LlamaConfig>(loadLlamaConfig);
  const [autostart, setAutostart] = useState(() => localStorage.getItem(LLAMA_AUTOSTART_KEY) === "true");
  const [models, setModels] = useState<string[]>([]);
  const mainModels = models.filter((m) => !m.toLowerCase().includes("mmproj"));
  const mmprojModels = models.filter((m) => m.toLowerCase().includes("mmproj"));
  const [running, setRunning] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 중지 직후 유예: 포트가 잠깐 살아있어 헬스체크가 "실행 중"으로 오진하는 것을 막는다.
  const stoppedAtRef = useRef<number>(0);

  function updateConfig(patch: Partial<LlamaConfig>) {
    setConfig((c) => ({ ...c, ...patch }));
  }

  async function scanModels() {
    try {
      const files = await invoke<string[]>("llama_scan_models");
      setModels(files);
      // 스캔 결과에 없는 모델/mmproj/model_draft는 자동 초기화
      setConfig((c) => ({
        ...c,
        model: files.includes(c.model) ? c.model : "",
        mmproj: files.includes(c.mmproj) ? c.mmproj : "",
        model_draft: files.includes(c.model_draft) ? c.model_draft : "",
      }));
    } catch (e) {
      console.warn("llama_scan_models failed:", e);
    }
  }

  // child handle 이 있으면 그걸 신뢰하고, 없으면 포트 헬스체크로 판정한다.
  // 앱이 직접 안 띄운 서버(외부 실행·이전 세션 잔존·autostart)도 "실행 중"으로 잡는다.
  // 단, 중지 직후 STOP_GRACE_MS 동안은 헬스체크를 건너뛴다(죽어가는 포트 오진 방지).
  const STOP_GRACE_MS = 3000;
  async function checkRunning() {
    try {
      if (await invoke<boolean>("llama_is_running")) {
        setRunning(true);
        return;
      }
    } catch { /* handle 확인 실패 → 헬스체크로 폴백 */ }

    if (Date.now() - stoppedAtRef.current < STOP_GRACE_MS) {
      setRunning(false);
      return;
    }
    try {
      const cfg = loadLlamaConfig();
      const host = cfg.host === "0.0.0.0" ? "127.0.0.1" : cfg.host;
      const res = await fetch(`http://${host}:${cfg.port}/health`, {
        signal: AbortSignal.timeout(1500),
      });
      setRunning(res.ok);
    } catch {
      setRunning(false);
    }
  }

  useEffect(() => {
    scanModels();
    checkRunning();
    pollingRef.current = setInterval(checkRunning, 3000);
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  function saveConfig() {
    localStorage.setItem(LLAMA_CONFIG_KEY, JSON.stringify(config));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  async function startServer() {
    localStorage.setItem(LLAMA_CONFIG_KEY, JSON.stringify(config));
    setLoading(true);
    setServerError(null);
    stoppedAtRef.current = 0; // 유예 해제
    try {
      await invoke("llama_start", { config });
      setRunning(true);
    } catch (e) {
      setServerError(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function stopServer() {
    setLoading(true);
    stoppedAtRef.current = Date.now(); // 유예 시작: 죽어가는 포트를 "실행 중"으로 오진하지 않게
    try {
      await invoke("llama_stop", { port: config.port });
      setRunning(false);
    } catch (e) {
      console.warn("llama_stop failed:", e);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">로컬 LLM 모델 실행</h3>

      {/* 상태 표시 */}
      {running !== null && (
        <div className={`server-status ${running ? "server-status--running" : "server-status--stopped"}`}>
          {running ? "실행 중" : "중지됨"}
        </div>
      )}

      {/* 에러 표시 */}
      {serverError && (
        <div className="server-error" onClick={() => setServerError(null)}>
          {serverError}
        </div>
      )}

      {/* 모델 선택 */}
      <div className="settings-row" style={{ alignItems: "center" }}>
        <span className="gen-param__label" style={{ width: 52, flexShrink: 0 }}>모델</span>
        <select
          className="server-select"
          value={config.model}
          onChange={(e) => updateConfig({ model: e.target.value })}
        >
          <option value="">-- 선택 --</option>
          {mainModels.map((m) => <option key={m} value={m}>{m.split("/").pop()}</option>)}
        </select>
        <button className="settings-btn settings-btn--ghost" style={{ flexShrink: 0 }} onClick={scanModels}>
          새로고침
        </button>
      </div>

      {/* mmproj 선택 */}
      <div className="settings-row" style={{ alignItems: "center" }}>
        <span className="gen-param__label" style={{ width: 52, flexShrink: 0 }}>mmproj</span>
        <select
          className="server-select"
          value={config.mmproj}
          onChange={(e) => updateConfig({ mmproj: e.target.value })}
        >
          <option value="">없음</option>
          {mmprojModels.map((m) => <option key={m} value={m}>{m.split("/").pop()}</option>)}
        </select>
      </div>

      {/* MTP 드래프트 모델 선택 */}
      <div className="settings-row" style={{ alignItems: "center" }}>
        <span className="gen-param__label" style={{ width: 52, flexShrink: 0 }}>MTP 모델</span>
        <select
          className="server-select"
          value={config.model_draft}
          onChange={(e) => updateConfig({ model_draft: e.target.value })}
        >
          <option value="">없음</option>
          {mainModels.map((m) => <option key={m} value={m}>{m.split("/").pop()}</option>)}
        </select>
      </div>

      {/* 2열 그리드 파라미터 */}
      <div className="gen-params-grid" style={{ marginTop: 4 }}>
        <label className="gen-param">
          <span className="gen-param__label">GPU 레이어</span>
          <input className="gen-param__input" type="number" step="1" min="0"
            value={config.ngl}
            onChange={(e) => updateConfig({ ngl: parseInt(e.target.value, 10) || 0 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">컨텍스트</span>
          <input className="gen-param__input" type="number" step="512" min="512"
            value={config.context}
            onChange={(e) => updateConfig({ context: parseInt(e.target.value, 10) || 2048 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">포트</span>
          <input className="gen-param__input" type="number" step="1" min="1024"
            value={config.port}
            onChange={(e) => updateConfig({ port: parseInt(e.target.value, 10) || 8803 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">호스트</span>
          <input className="gen-param__input" type="text"
            value={config.host}
            onChange={(e) => updateConfig({ host: e.target.value })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Temperature</span>
          <input className="gen-param__input" type="number" step="0.05" min="0" max="2"
            value={config.temp}
            onChange={(e) => updateConfig({ temp: parseFloat(e.target.value) || 1.0 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Top-K</span>
          <input className="gen-param__input" type="number" step="1" min="0"
            value={config.top_k}
            onChange={(e) => updateConfig({ top_k: parseInt(e.target.value, 10) || 0 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Top-P</span>
          <input className="gen-param__input" type="number" step="0.05" min="0" max="1"
            value={config.top_p}
            onChange={(e) => updateConfig({ top_p: parseFloat(e.target.value) || 0 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Min-P</span>
          <input className="gen-param__input" type="number" step="0.01" min="0" max="1"
            value={config.min_p}
            onChange={(e) => updateConfig({ min_p: parseFloat(e.target.value) || 0 })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">KV Cache K</span>
          <select className="gen-param__input server-select"
            value={config.ctk}
            onChange={(e) => updateConfig({ ctk: e.target.value })}>
            <option value="q4_0">q4_0</option>
            <option value="q8_0">q8_0</option>
            <option value="f16">f16</option>
          </select>
        </label>
        <label className="gen-param">
          <span className="gen-param__label">KV Cache V</span>
          <select className="gen-param__input server-select"
            value={config.ctv}
            onChange={(e) => updateConfig({ ctv: e.target.value })}>
            <option value="q4_0">q4_0</option>
            <option value="q8_0">q8_0</option>
            <option value="f16">f16</option>
          </select>
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Reasoning</span>
          <select className="gen-param__input server-select"
            value={config.reasoning}
            onChange={(e) => updateConfig({ reasoning: e.target.value })}>
            <option value="off">off</option>
            <option value="on">on</option>
          </select>
        </label>
        <label className="gen-param">
          <span className="gen-param__label">Reasoning Format</span>
          <select className="gen-param__input server-select"
            value={config.reasoning_format}
            onChange={(e) => updateConfig({ reasoning_format: e.target.value })}>
            <option value="none">none</option>
            <option value="deepseek-r1">deepseek-r1</option>
          </select>
        </label>
        <label className="gen-param">
          <span className="gen-param__label">MTP Draft</span>
          <input className="gen-param__input" type="number" step="1" min="0" max="8"
            title="Multi-Token Prediction 드래프트 토큰 수 (0=비활성, 1~4 권장). Qwen3-MTP 등 MTP 모델에서 추론 속도 향상."
            value={config.mtp_n_draft}
            onChange={(e) => updateConfig({ mtp_n_draft: parseInt(e.target.value, 10) || 0 })} />
        </label>
      </div>

      {/* Flash Attn / Jinja / Autostart 토글 */}
      <div className="server-checkbox-row">
        <label className="server-checkbox-row__item">
          <input type="checkbox" checked={config.flash_attn}
            onChange={(e) => updateConfig({ flash_attn: e.target.checked })} />
          <span>Flash Attn</span>
        </label>
        <label className="server-checkbox-row__item">
          <input type="checkbox" checked={config.jinja}
            onChange={(e) => updateConfig({ jinja: e.target.checked })} />
          <span>Jinja</span>
        </label>
        <label className="server-checkbox-row__item">
          <input type="checkbox" checked={autostart}
            onChange={(e) => {
              setAutostart(e.target.checked);
              localStorage.setItem(LLAMA_AUTOSTART_KEY, String(e.target.checked));
            }} />
          <span>앱 시작 시 자동 실행</span>
        </label>
      </div>

      {/* 액션 버튼 */}
      <div className="settings-row settings-row--right">
        <button className="settings-btn settings-btn--ghost" onClick={saveConfig}>
          {saved ? "저장됨" : "설정 저장"}
        </button>
        <button
          className="settings-btn settings-btn--stop"
          onClick={stopServer}
          disabled={loading || !running}
        >
          {loading && running ? "..." : "중지"}
        </button>
        <button
          className="settings-btn settings-btn--start"
          onClick={startServer}
          disabled={loading || !!running || !config.model}
        >
          {loading && !running ? "..." : "실행"}
        </button>
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

  function saveLlmUrl() {
    useSettingsStore.getState().setLlmUrl(llmUrl.trim());
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

          {/* ── llama-server 실행 ────────────────────────────────── */}
          <LlamaServerSection />

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

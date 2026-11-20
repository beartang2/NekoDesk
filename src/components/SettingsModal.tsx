import React, { useState, useEffect, useCallback, useRef } from "react";
import { QrScan } from "./QrScan";
import { IS_PHONE } from "../lib/platform";
import { invoke } from "@tauri-apps/api/core";
import { memoryApi, secretsApi, settingsApi, syncApi, type SyncDevice, type SyncStatus } from "../api/tauri";
import { appEvents } from "../lib/events";
import {
  X, Zap, Pencil, Trash2, Settings, Plus, RefreshCw, MapPin, Loader2, ChevronRight, ChevronUp, ChevronDown, ArrowUpRight, Info, Copy,
} from "lucide-react";
import { Accordion, AlertDialog, Popover } from "radix-ui";
import { AnimatePresence, Reorder, motion, useDragControls } from "motion/react";
import type { Memory } from "../agent/types";
import { loadTidyLog, type TidyRecord } from "../agent/memory-tidy";
import { forgetNote, loadMind, type MindNote, type NoteKind } from "../agent/neko-mind";
import { Collapse, EASE, IconButton, SavedLabel, Segmented, Select, SwitchRow, Switch, listItem } from "./ui";
import {
  getMcpTools,
  loadMcpServers as syncMcpRegistry,
  readMcpServerConfigs,
  writeMcpServerConfigs,
} from "../agent/mcp-registry";
import {
  DEFAULT_CHAT_SYSTEM_PROMPT,
} from "../agent/llm-client";
import { getStoredAccent, saveAccentHex, setAccentVars } from "../theme-colors";
import { useThemePref } from "../lib/theme";
import { NekoSettingsSection } from "../neko/NekoSettingsSection";
import { NekoDevSection } from "../neko/NekoDevSection";
import { DEFAULT_NEKO_NAME, nekoNameOf, useSettingsStore, type ImageProvider, type ToolMode } from "../stores/settingsStore";
import { josa } from "../lib/hangul";
import { getAllTools, getTool } from "../agent/tool-registry";
import {
  DEFAULT_LLAMA_CONFIG,
  activateProfile,
  isClaudeProfile,
  loadProfiles,
  modelLabel,
  newClaudeProfile,
  newId,
  probe,
  profileUrl,
  saveProfiles,
  type LlamaConfig,
  type ModelProfile,
  type ProfileState,
} from "../stores/modelProfiles";
import {
  CLAUDE_MODELS, claudeContextCap, claudeLabel, claudeModelOf, claudeUrl, findClaudeModel, fullRequestUsd, maxOutputTokensFor,
} from "../lib/claude-models";
import { CLAUDE_KEY, PLAIN_HTTP_HINT, isPlainHttp } from "../agent/llm-transport";
import { ClaudeBudgetFields, ClaudeUsageMeter } from "./ClaudeUsage";
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
            title="생각에 쓰는 토큰 상한입니다(-1: 제한 없음, 0: 생각 안 함). 생각이 너무 길면 512 정도를 권장합니다."
            value={config.reasoning_budget}
            onChange={(e) => onChange({ reasoning_budget: Number.isNaN(parseInt(e.target.value, 10)) ? -1 : parseInt(e.target.value, 10) })} />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">MTP Draft</span>
          <input className="gen-param__input" type="number" step="1" min="0" max="8"
            title="미리 예측할 토큰 수입니다(0: 끔, 1~4 권장). MTP 모델에서 답이 빨라집니다."
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

/**
 * Claude 프로필 편집기 — 모델, API 키, 예산.
 *
 * 키는 다른 API 키처럼 키체인에만 둔다. 화면은 저장 여부만 알고, 값을 붙여 보내는 건
 * Rust(claude.rs) 다. 모델을 바꾸면 이름이 기본값 그대로일 때만 이름도 따라 바꾼다 —
 * 사용자가 붙인 이름("네코 두뇌")은 건드리지 않는다.
 */
function ClaudeProfileFields({
  profile,
  onChange,
  onKeySaved,
}: {
  profile: ModelProfile;
  onChange: (patch: Partial<ModelProfile>) => void;
  onKeySaved: () => void;
}) {
  const model = claudeModelOf(profile.url) ?? CLAUDE_MODELS[0].id;
  const info = findClaudeModel(model);
  const chosen = useSettingsStore((s) => s.claudeContext[model]);
  const setClaudeContext = useSettingsStore((s) => s.setClaudeContext);
  const context = claudeContextCap(model, chosen);
  const full = fullRequestUsd(model, context);

  function setModel(next: string) {
    const renamed = profile.name === claudeLabel(model) ? { name: claudeLabel(next) } : {};
    onChange({ url: claudeUrl(next), ...renamed });
  }

  return (
    <>
      <div className="settings-field">
        <span className="settings-field__label">모델</span>
        <Segmented value={model} onChange={setModel}
          options={CLAUDE_MODELS.map((m) => ({ value: m.id, label: m.label }))} />
      </div>
      {info && (
        <p className="settings-section__desc">
          {info.hint} · 100만 토큰당 입력 ${info.price.input} / 출력 ${info.price.output}
          {info.price.longThreshold
            ? ` (${info.price.longThreshold / 1000}K 토큰을 넘는 요청은 $${info.price.longInput} / $${info.price.longOutput})`
            : ""}
        </p>
      )}
      {info && (
        <>
          <div className="settings-field">
            <span className="settings-field__label">컨텍스트</span>
            <Segmented value={String(context)} onChange={(v) => setClaudeContext(model, Number(v))}
              options={info.contextOptions.map((n) => ({
                value: String(n),
                label: n >= 1_000_000 ? `${n / 1_000_000}M` : `${n / 1000}K`,
              }))} />
          </div>
          <p className="settings-section__desc">
            컨텍스트를 가득 채우면 요청 한 번의 입력 비용은 최대 ${full < 0.01 ? full.toFixed(4) : full.toFixed(3)}입니다.
            {info.price.longThreshold && context > info.price.longThreshold
              ? ` ${info.price.longThreshold / 1000}K 토큰을 넘는 요청은 입력·출력 모두 ${info.price.longInput! / info.price.input}배 요금입니다.`
              : ""}
          </p>
        </>
      )}
      <div className="settings-field">
        <span className="settings-field__label">API 키</span>
        <SecretInput secretKey={CLAUDE_KEY} placeholder="sk-ant-…" onSaved={onKeySaved} />
      </div>
      <p className="settings-section__desc">
        Max 요금제의 월 API 크레딧을 쓰려면 claude.ai 설정 → 결제에서 Console 조직을 연결하고 그 조직의 키를 입력합니다.
      </p>
      <ClaudeBudgetFields />
    </>
  );
}

/** 이만큼 누르고 있으면 끌기가 시작된다. 그보다 짧으면 그냥 클릭(연결). */
const LONG_PRESS_MS = 350;
/** 누르는 사이 이보다 많이 움직이면 끌려는 게 아니라 스크롤·선택이다. */
const PRESS_SLOP_PX = 6;

/**
 * 프로필 한 줄. 누르면 연결하고, 꾹 누르면 들어 올려 순서를 바꾼다.
 *
 * 바로 끌리게 하면 연결하려고 누르다 살짝만 움직여도 줄이 따라 움직인다. 그래서
 * 끌기는 길게 눌렀을 때만 손으로 시작한다(dragListener 끔 + dragControls).
 */
function ProfileRow({
  profile: p, isDefault, isActive, live, busy, disabled, editing, canRemove, onConnect, onEdit, onRemove,
}: {
  profile: ModelProfile;
  isDefault: boolean;
  isActive: boolean;
  live: boolean | null;
  busy: boolean;
  disabled: boolean;
  editing: boolean;
  canRemove: boolean;
  onConnect: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const controls = useDragControls();
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);
  // 끌고 나서 손을 떼면 그 자리에 click 이 온다. 연결로 이어지지 않게 한 번 삼킨다.
  const dragged = useRef(false);
  const [lifted, setLifted] = useState(false);

  function cancelPress() {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  }

  useEffect(() => cancelPress, []);

  function onPointerDown(e: React.PointerEvent) {
    dragged.current = false;
    if (e.button !== 0 || (e.target as HTMLElement).closest(".mcp-row__btns")) return;
    const native = e.nativeEvent;
    press.current = {
      x: e.clientX,
      y: e.clientY,
      timer: window.setTimeout(() => {
        press.current = null;
        dragged.current = true;
        setLifted(true);
        controls.start(native);
      }, LONG_PRESS_MS),
    };
  }

  function onPointerMove(e: React.PointerEvent) {
    const start = press.current;
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > PRESS_SLOP_PX) cancelPress();
  }

  return (
    <Reorder.Item
      as="div"
      value={p}
      {...listItem}
      dragListener={false}
      dragControls={controls}
      onDragEnd={() => setLifted(false)}
      whileDrag={{ scale: 1.02 }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      // 들어 올리고 움직이지 않은 채 떼면 drag 가 시작되지 않아 onDragEnd 가 안 온다.
      onPointerUp={() => { cancelPress(); setLifted(false); }}
      onPointerCancel={() => { cancelPress(); setLifted(false); }}
      onClickCapture={(e) => {
        if (!dragged.current) return;
        dragged.current = false;
        e.stopPropagation();
        e.preventDefault();
      }}
      className={`profile-row ${isActive ? "profile-row--active" : ""} ${editing ? "profile-row--editing" : ""} ${lifted ? "profile-row--lifted" : ""}`}
    >
      <button className="profile-row__main" onClick={onConnect} disabled={disabled}>
        <span className={`profile-row__dot ${isActive && live ? "profile-row__dot--live" : ""}`} />
        <span className="profile-row__text">
          <span className="profile-row__name">
            {p.name}
            {isDefault && <span className="profile-row__default">기본</span>}
          </span>
          <span className="profile-row__sub">{modelLabel(p)}</span>
        </span>
        <span className="profile-row__state">
          {busy
            ? <><Loader2 size={11} className="ui-spin" />연결 중</>
            : isActive
            ? (live ? "연결됨" : isClaudeProfile(p) ? "키 없음" : "중지됨")
            : isClaudeProfile(p) ? "Claude" : p.config ? "로컬" : "외부"}
        </span>
      </button>
      <div className="mcp-row__btns">
        <IconButton label="편집" onClick={onEdit}><Pencil size={12} /></IconButton>
        <IconButton label="삭제" danger disabled={!canRemove} onClick={onRemove}><Trash2 size={12} /></IconButton>
      </div>
    </Reorder.Item>
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

  // 폰은 로컬 모델(llama.cpp)을 띄우지 못한다
  useEffect(() => { if (!IS_PHONE) scanModels(); }, [scanModels]);

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

  function addProfile(kind: "local" | "external" | "claude") {
    const p: ModelProfile =
      kind === "local"
        ? { id: newId(), name: "새 로컬 모델", url: "", config: { ...DEFAULT_LLAMA_CONFIG } }
        : kind === "claude"
        ? newClaudeProfile()
        : { id: newId(), name: "새 외부 서버", url: "http://", config: null };
    commit({ ...state, profiles: [...state.profiles, p] });
    setEditingId(p.id);
  }

  // 맨 위가 앱을 켤 때 연결되는 기본 프로필이다(App 의 시작 연결). 순서만 바꾸고
  // 지금 연결은 건드리지 않는다.
  function reorder(profiles: ModelProfile[]) {
    commit({ ...state, profiles });
  }

  function removeProfile(id: string) {
    const profiles = state.profiles.filter((p) => p.id !== id);
    if (!profiles.length) return; // 마지막 하나는 남긴다
    commit({ profiles, activeId: state.activeId === id ? profiles[0].id : state.activeId });
    if (editingId === id) setEditingId(null);
  }

  return (
    <>
      {/* Claude 로 묻는 동안엔 이번 주기에 얼마 썼는지가 늘 보여야 한다 — 돈이 나간다. */}
      <Collapse open={!!active && isClaudeProfile(active)}>
        <section className="settings-section">
          <ClaudeUsageMeter />
        </section>
      </Collapse>
      <section className="settings-section">
        <div className="settings-section__header">
          <h3 className="settings-section__title">모델 프로필</h3>
          {!IS_PHONE && (
            <button className="settings-btn settings-btn--ghost" onClick={scanModels} disabled={scanning}>
              <RefreshCw size={12} className={scanning ? "ui-spin" : undefined} />
              모델 새로고침
            </button>
          )}
        </div>
        <Collapse open={!!error}>
          <div className="server-error" onClick={() => setError(null)}>{error}</div>
        </Collapse>

        <Reorder.Group as="div" axis="y" values={state.profiles} onReorder={reorder} className="profile-list">
          <AnimatePresence mode="popLayout" initial={false}>
            {state.profiles.map((p, i) => (
              <ProfileRow
                key={p.id}
                profile={p}
                isDefault={i === 0}
                isActive={p.id === state.activeId}
                live={live}
                busy={busyId === p.id}
                disabled={busyId !== null}
                editing={editingId === p.id}
                canRemove={state.profiles.length > 1}
                onConnect={() => connect(p)}
                onEdit={() => setEditingId(editingId === p.id ? null : p.id)}
                onRemove={() => removeProfile(p.id)}
              />
            ))}
          </AnimatePresence>
        </Reorder.Group>

        <div className="settings-row">
          {!IS_PHONE && <button className="settings-btn settings-btn--ghost" onClick={() => addProfile("local")}><Plus size={12} />로컬 모델</button>}
          <button className="settings-btn settings-btn--ghost" onClick={() => addProfile("external")}><Plus size={12} />외부 서버</button>
          <button className="settings-btn settings-btn--ghost" onClick={() => addProfile("claude")}><Plus size={12} />Claude</button>
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
              ) : isClaudeProfile(editing) ? (
                <ClaudeProfileFields
                  profile={editing}
                  onChange={(patch) => patchProfile(editing.id, patch)}
                  onKeySaved={() => { if (editing.id === state.activeId) setLive(true); }}
                />
              ) : (
                <div className="settings-field">
                  <span className="settings-field__label">주소</span>
                  <input className="settings-input" value={editing.url}
                    placeholder="https://my-server.example.com"
                    onChange={(e) => patchProfile(editing.id, { url: e.target.value })} />
                  <Collapse open={isPlainHttp(editing.url)}>
                    <div className="server-error">{PLAIN_HTTP_HINT} 이 주소로는 연결하지 않아.</div>
                  </Collapse>
                </div>
              )}
            </div>
          )}
        </Collapse>
      </section>
    </>
  );
}

// ── Gen params section ────────────────────────────────────────────────────────

function GenParamsSection() {
  // 스토어를 직접 읽는다. 위의 프로필 목록에서 Claude 로 바꾸면 스토어가 값을 천장 안으로
  // 맞추는데, 여기서 따로 들고 있으면 옛 값이 화면에 남고 다시 저장된다.
  const params = useSettingsStore((s) => s.genParams);
  const setParams = useSettingsStore((s) => s.setGenParams);
  const llmUrl = useSettingsStore((s) => s.llmUrl);
  const cap = maxOutputTokensFor(llmUrl);
  const claude = claudeModelOf(llmUrl);

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">최대 응답 토큰</h3>
      {cap !== null && claude && (
        <p className="settings-section__desc">
          {claudeLabel(claude)}의 최대 답변 길이는 {cap.toLocaleString()} 토큰입니다.
        </p>
      )}
      <div className="gen-params-grid">
        <label className="gen-param">
          <span className="gen-param__label">에이전트</span>
          <input
            className="gen-param__input"
            type="number"
            step="128"
            min="64"
            max={cap ?? undefined}
            value={params.max_tokens_agent}
            onChange={(e) => setParams({ ...params, max_tokens_agent: parseInt(e.target.value, 10) || 2048 })}
          />
        </label>
        <label className="gen-param">
          <span className="gen-param__label">채팅</span>
          <input
            className="gen-param__input"
            type="number"
            step="128"
            min="64"
            max={cap ?? undefined}
            value={params.max_tokens_chat}
            onChange={(e) => setParams({ ...params, max_tokens_chat: parseInt(e.target.value, 10) || 512 })}
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
      <h3 className="settings-section__title">도구 사용 방식</h3>
      <p className="settings-section__desc">
        네이티브는 도구 여러 개를 한 번에 사용합니다. llama-server 를 <code>--jinja</code> 로 실행해야 합니다.
        JSON 은 한 번에 도구 하나만 사용합니다.
      </p>
      <Segmented
        value={toolMode}
        onChange={setToolMode}
        options={(Object.keys(TOOL_MODE_LABELS) as ToolMode[]).map((m) => ({ value: m, label: TOOL_MODE_LABELS[m] }))}
      />
      <Collapse open={toolMode === "auto" && degraded}>
        <div className="settings-feedback">
          서버가 네이티브 방식을 지원하지 않아 JSON 방식으로 동작 중입니다.
          llama-server 를 <code>--jinja</code> 로 다시 실행하면 자동으로 돌아갑니다.
        </div>
      </Collapse>
    </section>
  );
}

function MemorySection() {
  const autoCompact = useSettingsStore((s) => s.autoCompact);
  const setAutoCompact = useSettingsStore((s) => s.setAutoCompact);
  const name = useSettingsStore(nekoNameOf);
  return (
    <section className="settings-section">
      <h3 className="settings-section__title">자동 요약</h3>
      <p className="settings-section__desc">
        대화가 길어지면 {josa(name, "이/가")} 앞부분을 요약해 기억합니다. 끄면 오래된 내용은 잊습니다.
        화면의 대화는 어느 쪽이든 남습니다. Claude 는 요약 한 번에 요청 한 번 정도 비용이 듭니다.
      </p>
      <Segmented
        value={autoCompact ? "on" : "off"}
        onChange={(v) => setAutoCompact(v === "on")}
        options={[{ value: "on", label: "켬" }, { value: "off", label: "끔" }]}
      />
    </section>
  );
}

function SessionRetentionSection() {
  const days = useSettingsStore((s) => s.sessionRetention);
  const setDays = useSettingsStore((s) => s.setSessionRetention);
  return (
    <section className="settings-section">
      <h3 className="settings-section__title">오래된 대화 지우기</h3>
      <p className="settings-section__desc">
        이 기간 동안 쓰지 않은 대화를 앱을 켤 때 지웁니다. 열린 대화와 기억은 남습니다. 지운 대화는 되살릴 수 없습니다.
        처음 켠 날부터 이 기간 동안은 지우지 않습니다.
      </p>
      <Segmented
        value={String(days)}
        onChange={(v) => setDays(v === "0" ? 0 : v === "90" ? 90 : 30)}
        options={[{ value: "0", label: "끔" }, { value: "30", label: "30일" }, { value: "90", label: "90일" }]}
      />
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
  const name = useSettingsStore(nekoNameOf);
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
        {josa(name, "이/가")} 대화할 때 참고하는 내 정보입니다.
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
  const name = useSettingsStore(nekoNameOf);
  // 글자마다 저장하면 칠 때마다 날씨를 새로 찾는다. 다 치고 나서 쓴다.
  const [draft, setDraft] = useState(location);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 위치 서비스에 묻는다. 처음 한 번은 권한 창이 뜬다.
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
      <h3 className="settings-section__title">날씨와 위치</h3>
      <p className="settings-section__desc">
        {name} 방 액자에 날씨를 표시합니다. 최근에 앱을 연 기기의 동네를 먼저 쓰고, 어느 기기도 위치를 모르면
        이 지역을 씁니다(산책 지도의 집도 같습니다). 둘 다 없으면 표시하지 않습니다.
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
        확인 창에서 "항상" 을 고른 작업입니다. 지우면 다음부터 다시 묻습니다.
        위험한 명령(rm -rf, sudo 등)은 매번 확인합니다.
      </p>
      {empty ? (
        <div className="settings-empty">없습니다.</div>
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
  neko: "산책",
};

/**
 * 기억·정리 기록·속마음은 5개씩 넘겨 본다. 지워서 줄면 마지막 쪽으로 당긴다(쪽 번호를 그릴 때 자른다).
 * 한 줄로 잘린 줄은 눌러서 펼친다(open·toggle) — 쪽을 넘기면 펼친 것을 다 접는다(돌아와도 접혀 있다)
 */
const PAGE = 5;
function usePage<T>(items: T[]) {
  const [want, setWant] = useState(0);
  const [open, setOpen] = useState<ReadonlySet<string | number>>(new Set());
  const last = Math.max(0, Math.ceil(items.length / PAGE) - 1);
  const page = Math.min(want, last);
  const setPage = (p: number) => { setWant(p); setOpen(new Set()); };
  const toggle = (id: string | number) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return { page, last, setPage, shown: items.slice(page * PAGE, page * PAGE + PAGE), total: items.length, open, toggle };
}

function Pager({ page, last, setPage, total }: ReturnType<typeof usePage>) {
  if (total <= PAGE) return null;
  return (
    <div className="memory-pager">
      <span className="memory-pager__at">{page * PAGE + 1}–{Math.min(total, page * PAGE + PAGE)} / {total}</span>
      <IconButton label="이전 5개" disabled={page === 0} onClick={() => setPage(page - 1)}><ChevronUp size={12} /></IconButton>
      <IconButton label="다음 5개" disabled={page === last} onClick={() => setPage(page + 1)}><ChevronDown size={12} /></IconButton>
    </div>
  );
}

/**
 * 고양이가 기억해둔 것들. 지우는 수단이 없으면 기억은 무섭기만 하다 — 무엇을
 * 알고 있는지 보이고 지울 수 있어야 한다.
 */
export function MemoriesSection() {
  const [memories, setMemories] = useState<Memory[]>([]);

  const refresh = useCallback(async () => {
    try {
      setMemories(await memoryApi.list());
    } catch {
      setMemories([]);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  // 다른 기기에서 기억이 왔다
  useEffect(() => appEvents.on("syncChanged", ({ colls }) => { if (colls.includes("memory")) void refresh(); }), [refresh]);

  // 쉴 때 정리(agent/memory-tidy): 켜고 끄기와 최근에 무엇을 합쳤는지
  const tidy = useSettingsStore((s) => s.memoryTidy);
  const setTidy = useSettingsStore((s) => s.setMemoryTidy);
  const name = useSettingsStore(nekoNameOf);
  const [tidyLog, setTidyLog] = useState<TidyRecord[]>([]);
  useEffect(() => { void loadTidyLog().then(setTidyLog); }, []);
  // 목록은 최근 저장한 것이 위(memory_list 가 created_at DESC 로 준다)
  const memPage = usePage(memories);
  const logPage = usePage(tidyLog);
  // 한 줄로 잘린 기억은 눌러서 펼쳐 읽는다(쪽을 넘기면 접힌다)
  const { open, toggle } = memPage;

  async function remove(id: number) {
    await memoryApi.delete(id).catch(() => {});
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">{josa(name, "이/가")} 기억하는 것</h3>
      <p className="settings-section__desc">
        대화하면서 알게 된 것입니다. 다음 대화에서 관련된 것만 자동으로 떠올립니다.
      </p>
      {memories.length === 0 ? (
        <div className="settings-empty">기억한 것이 없습니다.</div>
      ) : (
        <div className="rule-list">
          <AnimatePresence mode="popLayout" initial={false}>
            {memPage.shown.map((m) => (
              // layout="position": 펼칠 때 크기까지 늘려 그리면 글자가 잠깐 찌그러진다. 아래 줄만 미끄러지게
              <motion.div className={`rule-row${open.has(m.id) ? " memory-row--open" : ""}`} key={m.id} {...listItem} layout="position">
                <span className="memory-row__kind">{MEMORY_KIND_LABELS[m.kind] ?? m.kind}</span>
                <button type="button" className="memory-row__text" aria-expanded={open.has(m.id)} onClick={() => toggle(m.id)}>
                  <span className="rule-row__key">{m.content}</span>
                </button>
                <IconButton label="잊기" danger onClick={() => remove(m.id)}><Trash2 size={12} /></IconButton>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}
      <Pager {...memPage} />
      <SwitchRow label="쉴 때 정리하기" checked={tidy} onChange={setTidy} />
      <p className="settings-section__desc">
        {josa(name, "이/가")} 졸 때 하루 한 번 겹치는 기억을 합치고, 일정·할 일처럼 바로 찾아볼 수 있는 기억은 지웁니다.
        모델이 Claude 이고 산책 중이 아닐 때만 동작합니다.
      </p>
      {tidyLog.length > 0 && (
        <details className="memory-tidy-log">
          <summary>최근 정리 {tidyLog.length}번</summary>
          {logPage.shown.map((r) => (
            <div key={r.at} className="memory-tidy-log__day">
              <div className="memory-tidy-log__at">{TIDY_AT.format(new Date(r.at))}</div>
              {r.merges.map((m, i) => (
                <div key={i} className="memory-tidy-log__merge">
                  <span className="memory-tidy-log__from">{m.from.join(" · ")}</span>
                  <span className="memory-tidy-log__to">→ {m.to}</span>
                </div>
              ))}
              {r.drops?.map((d, i) => (
                <div key={`d${i}`} className="memory-tidy-log__merge">
                  <span className="memory-tidy-log__from">{d}</span>
                  <span className="memory-tidy-log__to">→ 지움(찾아볼 수 있어서)</span>
                </div>
              ))}
            </div>
          ))}
          <Pager {...logPage} />
        </details>
      )}
    </section>
  );
}

const TIDY_AT = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

const MIND_KIND: Record<NoteKind, string> = { wonder: "궁금", want: "하고 싶음", chose: "고름", dream: "꿈" };
const MIND_AT = new Intl.DateTimeFormat("ko-KR", { month: "numeric", day: "numeric" });

/**
 * 네코의 속마음(agent/neko-mind, docs/neko-mind.md): 네코가 고르며 남긴 짧은 노트. 맥·폰이 같이 본다(동기화 설정 neko_mind).
 * 최근 것이 위, 5개씩 넘긴다. 하나씩 지울 수 있다
 */
export function MindNotesSection() {
  const name = useSettingsStore(nekoNameOf);
  const [notes, setNotes] = useState<MindNote[]>([]);
  const refresh = useCallback(() => { void loadMind().then((m) => setNotes([...m.notes].reverse())); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => appEvents.on("syncChanged", ({ colls }) => { if (colls.includes("setting")) refresh(); }), [refresh]);
  const page = usePage(notes);
  async function remove(n: MindNote) {
    const m = await forgetNote(n);
    setNotes([...m.notes].reverse());
  }
  return (
    <section className="settings-section">
      <h3 className="settings-section__title">{name}의 속마음</h3>
      <p className="settings-section__desc">
        {josa(name, "이/가")} 산책 주제를 고르며 남긴 짧은 노트입니다. 궁금한 것, 하고 싶은 것, 고른 까닭이 다음 선택의 재료가 됩니다.
        맥과 폰이 같이 씁니다.
      </p>
      {notes.length === 0 ? (
        <div className="settings-empty">아직 남긴 노트가 없습니다.</div>
      ) : (
        <div className="rule-list">
          {page.shown.map((n) => {
            // 기억 목록처럼 눌러서 펼친다(쪽을 넘기면 접힌다)
            const id = `${n.at}${n.text}`, isOpen = page.open.has(id);
            return (
              <div className={`rule-row${isOpen ? " memory-row--open" : ""}`} key={id}>
                <span className="memory-row__kind">{MIND_KIND[n.kind]}</span>
                <button type="button" className="memory-row__text" aria-expanded={isOpen} onClick={() => page.toggle(id)}>
                  <span className="rule-row__key">{n.text}{n.why ? ` — ${n.why}` : ""}</span>
                </button>
                <span className="mind-row__at">{MIND_AT.format(new Date(n.at))}</span>
                <IconButton label="지우기" danger onClick={() => void remove(n)}><Trash2 size={12} /></IconButton>
              </div>
            );
          })}
        </div>
      )}
      <Pager {...page} />
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

/** 동기화 시각: 오늘이면 "오전 9:33", 아니면 "11월 18일 오전 9:33", 다른 해면 연도까지. 초는 안 보인다 */
function syncTime(ms: number): string {
  const d = new Date(ms), now = new Date();
  const time: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("ko-KR", time);
  return d.toLocaleString("ko-KR", { ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}), month: "long", day: "numeric", ...time });
}

/** Rust 가 한글 문구를 주면 그대로, 아니면(연결 실패 등 영어 오류) 사람이 읽을 말로 */
const syncError = (e: unknown): string => {
  const msg = String(e);
  return /[가-힣]/.test(msg) ? msg.replace(/^Error:\s*/, "") : "서버에 연결하지 못했습니다. 서버 주소와 인터넷 연결을 확인하십시오.";
};

/** 되돌릴 수 없는 일 확인(기기 끊기·암호 키 재설정). 처음 포커스는 취소, Esc 도 취소 */
interface SyncAsk { title: string; desc: string; ok: string; run: () => Promise<void> }

/**
 * 설정 › 연동 › 동기화(docs/neko-sync.md). 기본은 꺼져 있고, 켜기 전엔 아무것도 밖으로 안 나간다.
 * 첫 맥: 서버 주소 + 배포 때 정한 SETUP_TOKEN 으로 등록. 다음 기기: 다른 기기가 만든 기기 연결 코드를 붙여넣는다.
 */
function SyncSection() {
  const [st, setSt] = useState<SyncStatus | null>(null);
  const [url, setUrl] = useState("");
  const [setup, setSetup] = useState("");
  const [pasted, setPasted] = useState("");
  const [pairing, setPairing] = useState("");
  // 폰: 붙여넣기 버튼. 시스템 클립보드를 직접 읽고(웹뷰의 붙여넣기가 안 되는 일이 있다), 안 되면 웹 쪽으로 한 번 더
  async function pasteCode() {
    setErr("");
    const text = (await invoke<string | null>("paste_text").catch(() => null)) ?? (await navigator.clipboard.readText().catch(() => null));
    if (text === null) setErr("붙여넣지 못했습니다. 붙여넣기 허용 여부를 확인하십시오.");
    else if (!text.trim().startsWith("nekosync1:")) setErr("복사한 기기 연결 코드가 없습니다. 맥에서 코드를 복사한 뒤 다시 누르십시오.");
    else setPasted(text.trim());
  }
  // 폰: 앱 안에서 QR 찍기
  const [scanning, setScanning] = useState(false);
  // 맥: 코드를 QR 로도 보인다(폰에서는 긴 코드를 못 친다). 숨기면 같이 사라진다
  const [qr, setQr] = useState("");
  useEffect(() => {
    setQr("");
    if (pairing && !IS_PHONE) void syncApi.pairQr(pairing).then(setQr).catch(() => {});
  }, [pairing]);
  // 기기 연결 코드에 Claude API 키도 싣는다(아이폰은 긴 키를 치기 어렵다). 키가 있을 때만 고를 수 있다
  const [hasClaude, setHasClaude] = useState(false);
  const [withClaude, setWithClaude] = useState(true);
  useEffect(() => { secretsApi.has("anthropic_api_key").then(setHasClaude).catch(() => {}); }, []);
  const [devices, setDevices] = useState<{ devices: SyncDevice[]; me: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [ask, setAsk] = useState<SyncAsk | null>(null);
  const refresh = useCallback(() => { syncApi.status().then(setSt).catch(() => {}); }, []);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, 5000);
    return () => window.clearInterval(t);
  }, [refresh]);

  const loadDevices = () => run(async () => setDevices(await syncApi.devices()));
  const revoke = (d: SyncDevice) => setAsk({
    title: `'${d.name}' 기기 연결을 끊으시겠습니까?`,
    desc: "그 기기는 더 이상 동기화할 수 없습니다. 잃어버린 기기라면 암호 키도 재설정하십시오.",
    ok: "끊기",
    run: async () => { await syncApi.revoke(d.id); setDevices(await syncApi.devices()); },
  });
  const rekey = () => setAsk({
    title: "암호 키를 재설정하시겠습니까?",
    desc: "다른 기기의 연결이 모두 끊기고, 서버 기록을 비운 뒤 이 맥의 내용을 새 암호 키로 다시 올립니다. 다른 기기는 새 기기 연결 코드로 다시 연결해야 합니다.",
    ok: "재설정",
    run: async () => { await syncApi.rekey(); setPairing(""); setDevices(await syncApi.devices()); },
  });

  async function run(job: () => Promise<unknown>) {
    setBusy(true);
    setErr("");
    try { await job(); } catch (e) { setErr(syncError(e)); } finally { setBusy(false); refresh(); }
  }

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">동기화</h3>
      <p className="settings-section__desc">
        다른 기기와 대화, 기억, 할 일, 선물, 이름을 동기화합니다. 내용은 이 기기에서 암호화한 뒤 올리므로 서버는 읽을 수 없습니다.
        켜기 전에는 아무것도 보내지 않습니다.
      </p>
      {st?.registered ? (
        <>
          <Segmented
            value={st.enabled ? "on" : "off"}
            onChange={(v) => void run(() => syncApi.enable(v === "on"))}
            options={[{ value: "on", label: "켬" }, { value: "off", label: "끔" }]}
          />
          <p className="settings-section__desc">
            {st.url} · 마지막 동기화: {st.last_sync ? syncTime(st.last_sync) : "아직 없음"}
            {st.last_error ? ` · 동기화 실패: ${syncError(st.last_error)}` : ""}
          </p>
          <div className="settings-row">
            <button className="settings-btn settings-btn--ghost" disabled={busy || !st.enabled} onClick={() => void run(() => syncApi.now())}>
              지금 동기화
            </button>
            <button className="settings-btn settings-btn--ghost" disabled={busy} onClick={() => void run(async () => setPairing(await syncApi.pairMake(hasClaude && withClaude)))}>
              기기 연결 코드 만들기
            </button>
            <button className="settings-btn settings-btn--ghost" disabled={busy} onClick={() => void loadDevices()}>연결된 기기</button>
          </div>
          {hasClaude && (
            <label className="settings-section__desc">
              <input type="checkbox" checked={withClaude} onChange={(e) => setWithClaude(e.target.checked)} />
              {" "}기기 연결 코드에 Claude API 키도 넣기(아이폰에서 키를 따로 넣지 않아도 됩니다)
            </label>
          )}
          {pairing && (
            <>
              <p className="settings-section__desc">
                다른 기기의 설정 › 연동 › 동기화에 붙여넣습니다. 10분 동안 한 번만 쓸 수 있습니다. 암호 키가 들어 있으므로 다른 사람에게 보내지 마십시오.
              </p>
              <div className="settings-row">
                <input className="settings-input" readOnly value={pairing} onFocus={(e) => e.currentTarget.select()} />
                <button className="settings-btn settings-btn--ghost" onClick={() => { void navigator.clipboard.writeText(pairing); }}>복사</button>
                <button className="settings-btn settings-btn--ghost" onClick={() => setPairing("")}>숨기기</button>
              </div>
              {qr && (
                <>
                  <img className="sync-qr" alt="기기 연결 QR" src={`data:image/svg+xml;utf8,${encodeURIComponent(qr)}`} />
                  <p className="settings-section__desc">아이폰 카메라로 이 QR 을 찍으면 NekoDesk 가 열립니다.</p>
                </>
              )}
            </>
          )}
          {devices && (
            <ul className="settings-section__desc sync-devices">
              {devices.devices.map((d) => (
                <li key={d.id}>
                  <span>
                    {d.name}{d.id === devices.me ? " (이 기기)" : ""}
                    {" · "}{d.revoked ? "연결 끊김" : d.last_seen ? `마지막 접속 ${syncTime(d.last_seen)}` : "아직 접속 안 함"}
                  </span>
                  {d.id !== devices.me && !d.revoked && (
                    <button className="settings-btn settings-btn--ghost" disabled={busy} onClick={() => revoke(d)}>끊기</button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/* 위험 동작: 다른 버튼과 떨어뜨려 맨 아래에 */}
          <p className="settings-section__desc sync-danger">
            기기를 잃어버렸다면 암호 키를 재설정하십시오. 다른 기기의 연결이 모두 끊깁니다.
          </p>
          <div className="settings-row">
            <button className="settings-btn settings-btn--stop" disabled={busy} onClick={rekey}>암호 키 재설정</button>
          </div>
        </>
      ) : (
        <>
          {!IS_PHONE && (
            <>
              <p className="settings-section__desc">처음 쓰는 맥이라면 서버 주소와 서버 배포 때 정한 설정 토큰(SETUP_TOKEN)을 입력하십시오.</p>
              <div className="settings-row">
                <input className="settings-input" value={url} placeholder="https://sync.example.com" onChange={(e) => setUrl(e.target.value)} />
                <input className="settings-input" type="password" value={setup} placeholder="SETUP_TOKEN" onChange={(e) => setSetup(e.target.value)} />
                <button className="settings-btn settings-btn--ghost" disabled={busy || !url || !setup} onClick={() => void run(() => syncApi.setup(url, setup).then(() => setSetup("")))}>
                  등록하고 켜기
                </button>
              </div>
            </>
          )}
          <p className="settings-section__desc">
            {IS_PHONE
              ? "맥의 설정 › 연동 › 동기화에서 '기기 연결 코드 만들기'를 누르고, 나온 QR 을 찍으십시오. QR 을 찍을 수 없으면 코드를 복사해 아래에 붙여넣으십시오."
              : "다른 기기에서 이미 쓰고 있다면 그 기기에서 만든 기기 연결 코드를 붙여넣으십시오."}
          </p>
          {IS_PHONE && (
            <div className="settings-row">
              <button className="settings-btn" disabled={busy} onClick={() => setScanning(true)}>QR 찍기</button>
            </div>
          )}
          {scanning && <QrScan onClose={() => setScanning(false)} />}
          <div className="settings-row">
            <input className="settings-input" type="password" value={pasted} placeholder="nekosync1:…" onChange={(e) => setPasted(e.target.value)} />
            {/* 폰: 긴 코드를 손으로 칠 수는 없다. 길게 눌러 붙여넣기를 못 찾아도 한 번에 붙게(iOS 가 붙여넣기 허용을 묻는다) */}
            {IS_PHONE && (
              <button className="settings-btn settings-btn--ghost" disabled={busy}
                onClick={() => void pasteCode()}>
                붙여넣기
              </button>
            )}
            <button className="settings-btn settings-btn--ghost" disabled={busy || !pasted} onClick={() => void run(() => syncApi.pairJoin(pasted).then(() => setPasted("")))}>
              연결하기
            </button>
          </div>
        </>
      )}
      {err && <p className="settings-section__desc settings-section__desc--error">{err}</p>}
      <AlertDialog.Root open={!!ask} onOpenChange={(open) => { if (!open) setAsk(null); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="update-overlay">
            <AlertDialog.Content className="update-dialog">
              <AlertDialog.Title className="update-dialog__title">{ask?.title}</AlertDialog.Title>
              <AlertDialog.Description className="update-dialog__sub">{ask?.desc}</AlertDialog.Description>
              <div className="update-dialog__actions">
                <AlertDialog.Cancel className="update-dialog__btn">취소</AlertDialog.Cancel>
                <AlertDialog.Action className="update-dialog__btn update-dialog__btn--danger" onClick={() => { if (ask) void run(ask.run); }}>
                  {ask?.ok}
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Overlay>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </section>
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
  const name = useSettingsStore(nekoNameOf);
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
        {josa(name, "이/가")} 그림을 그릴 때 쓰는 서비스입니다. Cloudflare Workers AI 는 하루 무료 사용량이 있고
        계정 ID 와 Workers AI 권한 토큰이 필요합니다. Google 은 AI Studio 의 Gemini API 키를 쓰며 모델에 따라 요금이 나옵니다.
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

type PermState = "allowed" | "denied" | "ask";
type PhonePerms = Record<"location" | "music" | "camera" | "paste", PermState>;

const PHONE_PERMS: { key: keyof PhonePerms; label: string; desc: string }[] = [
  { key: "location", label: "위치", desc: "날씨·산책 지도의 집" },
  { key: "music", label: "음악 보관함", desc: "곡을 찾아 틀기·지금 듣는 곡" },
  { key: "camera", label: "카메라", desc: "맥 화면의 연결 QR 찍기" },
  { key: "paste", label: "붙여넣기", desc: "다른 앱에서 복사한 글" },
];

/** 폰이 쓰는 권한. 아직 안 물은 것은 누르면 iOS 권한 창, 나머지는 설정 앱의 이 앱 화면 */
function PhonePermSection() {
  const [perms, setPerms] = useState<PhonePerms | null>(null);
  const refresh = useCallback(() => {
    invoke<PhonePerms>("phone_permissions").then(setPerms).catch(console.warn);
  }, []);
  // 설정 앱에서 바꾸고 돌아오면 다시 읽는다
  useEffect(() => {
    refresh();
    const onShow = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [refresh]);

  function press(key: keyof PhonePerms) {
    if (key !== "paste" && perms?.[key] === "ask") {
      invoke<PhonePerms>("phone_permission_ask", { kind: key }).then(setPerms).catch(console.warn);
    } else {
      invoke("phone_open_settings").catch(console.warn);
    }
  }

  const stateText = (key: keyof PhonePerms) =>
    key === "paste" ? "붙여넣을 때 묻습니다"
    : !perms ? ""
    : perms[key] === "allowed" ? "허용"
    : perms[key] === "denied" ? "거절"
    : "아직 묻지 않음";

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">권한 설정</h3>
      <p className="settings-section__desc">
        폰 앱이 쓰는 권한입니다. 아직 묻지 않은 권한은 누르면 묻고, 나머지는 설정 앱에서 바꿉니다.
      </p>
      <div className="perm-grid">
        {PHONE_PERMS.map(({ key, label, desc }) => (
          <button key={key} className="perm-btn" onClick={() => press(key)}>
            <span className="perm-btn__label">{label}</span>
            <span className="perm-btn__desc">{desc}</span>
            <span className="perm-btn__state" data-state={key === "paste" ? "ask" : perms?.[key]}>{stateText(key)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function McpSection() {
  const name = useSettingsStore(nekoNameOf);
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
        MCP 서버를 연결하면 {josa(name, "이/가")} 쓸 수 있는 도구가 늘어납니다.
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
  const name = useSettingsStore(nekoNameOf);
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
      <p className="settings-section__desc">{josa(name, "이/가")} 쓸 수 있는 도구입니다. 누르면 설명을 볼 수 있습니다.</p>
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
                <div className="settings-empty tool-group__empty">연결된 MCP 도구가 없습니다. 연동 탭에서 서버를 추가할 수 있습니다.</div>
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
  // Accent color (full hex — hue + saturation + lightness 모두 반영)
  const themePref = useThemePref((s) => s.pref);
  const setThemePref = useThemePref((s) => s.setPref);
  const [accentHex, setAccentHex] = useState(() => getStoredAccent());
  const accentInputRef = useRef<HTMLInputElement | null>(null);

  function handleAccentChange(hex: string) {
    setAccentHex(hex);
    saveAccentHex(hex);
    setAccentVars(hex, isDark);
  }

  function resetAccent() {
    const defaultHex = "#75a7ce";
    saveAccentHex(defaultHex);
    setAccentVars(defaultHex, isDark);
    setAccentHex(defaultHex);
  }

  // 이름은 칠 때마다 저장해서 화면 곳곳이 바로 따라 바뀐다.
  const nekoNameRaw = useSettingsStore((s) => s.nekoName);
  const setNekoName = useSettingsStore((s) => s.setNekoName);
  const nekoName = useSettingsStore(nekoNameOf);

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
              {/* ── 테마 ─────────────────────────────────────────────── */}
              <section className="settings-section">
                <div className="settings-section__header">
                  <h3 className="settings-section__title">테마</h3>
                  <Segmented
                    value={themePref}
                    onChange={setThemePref}
                    options={[
                      { value: "light", label: "라이트" },
                      { value: "dark", label: "다크" },
                      { value: "system", label: "시스템" },
                    ]}
                  />
                </div>
              </section>

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

              {/* ── 고양이(네코): 외형·자리 ─────────────────────────── */}
              <NekoSettingsSection />

              {/* ── 사용자 프로필 ────────────────────────────────────── */}
              <UserProfileSection />

              {/* ── 네코 프로필: 이름 + 시스템 프롬프트 ─────────────────── */}
              <section className="settings-section">
                <h3 className="settings-section__title">네코 프로필</h3>
                <div className="settings-field">
                  <span className="settings-field__label">이름</span>
                  <input className="settings-input" value={nekoNameRaw} placeholder={DEFAULT_NEKO_NAME}
                    onChange={(e) => setNekoName(e.target.value)} />
                </div>
                <p className="settings-section__desc">
                  {nekoName}의 성격과 말투를 직접 정할 수 있습니다.
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
              <MindNotesSection />

              {/* ── 개발자(개발 빌드에서만 — 배포 빌드엔 칸이 없다) ──────── */}
              {import.meta.env.DEV && <NekoDevSection />}
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
              <MemorySection />
              <SessionRetentionSection />
            </>
          )}
          {tab === "connect" && (
            <>
              {/* ── 날씨와 위치 ──────────────────────────────────────── */}
              <WeatherSection />

              {/* ── 이미지 생성 ──────────────────────────────────────── */}
              <ImageGenSection />

              {/* ── Brave Search API ─────────────────────────────────── */}
              <section className="settings-section">
                <h3 className="settings-section__title">Brave Search API</h3>
                <p className="settings-section__desc">
                  DuckDuckGo 결과가 없을 때 대신 사용합니다. api.search.brave.com 에서 무료로 받을 수 있습니다(월 2,000회).
                </p>
                <div className="settings-row">
                  <SecretInput secretKey="brave_search_key" placeholder="BSA..." onSaved={onBraveSaved} />
                  {braveSearchSaved && <SavedLabel saved />}
                </div>
              </section>

              {/* ── MCP 서버 (폰은 stdio 서버를 못 띄운다) ──────────────── */}
              {!IS_PHONE && <McpSection />}

              {/* ── 기기 간 동기화 ───────────────────────────────────── */}
              <SyncSection />
            </>
          )}
          {tab === "tools" && <ToolsSection />}
          {tab === "perm" && (
            <>
              <UpdateSection />

              {/* ── 항상 허용한 작업 ──────────────────────────────────── */}
              <ToolRulesSection />

              {/* ── 권한 설정 ─────────────────────────────────────────── */}
              {IS_PHONE ? <PhonePermSection /> : <section className="settings-section">
                <h3 className="settings-section__title">권한 설정</h3>
                <p className="settings-section__desc">
                  앱에 필요한 macOS 권한입니다. 누르면 시스템 설정이 열립니다.
                </p>
                <div className="perm-grid">
                  {[
                    {
                      label: "손쉬운 사용",
                      desc: "다른 앱 제어",
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
                    {
                      label: "위치 서비스",
                      desc: "현재 위치(날씨·산책 지도의 집)",
                      url: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices",
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
              </section>}
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

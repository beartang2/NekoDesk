import { Channel, invoke } from "@tauri-apps/api/core";
import { WEB_SEARCH_MODEL, WEB_SEARCH_USD, claudeContextCap, claudeModelOf, findClaudeModel } from "../lib/claude-models";
import { createMessagesStreamAdapter, toMessagesRequest, type MessagesUsage } from "./claude-messages";
import { redactSecrets } from "./outbound-guard";
import { maskHome } from "../lib/home";
import type { NativeSearchResult } from "./types";
import { budgetBlockReason, useClaudeBudget } from "../stores/claudeBudget";
import { useSettingsStore } from "../stores/settingsStore";

/**
 * LLM 요청이 나가는 단 하나의 문.
 *
 * 로컬·외부 프로필이면 지금까지처럼 그 주소로 `fetch` 한다. Claude 프로필(`claude://모델`)이면
 * OpenAI 모양 요청을 Messages API 모양으로 바꿔(claude-messages) Rust 의 `claude_chat` 에 넘기고,
 * Rust 가 키체인의 키를 붙여 api.anthropic.com/v1/messages 로 중계한다. 받은 스트림은 다시
 * OpenAI 모양으로 바꿔 표준 `Response` 로 돌려준다 — llm-client 의 파싱은 어느 쪽이든 같다.
 */

/** 키체인 항목 이름. src-tauri/src/claude.rs 의 KEY_NAME 과 같아야 한다. */
export const CLAUDE_KEY = "anthropic_api_key";

type Json = Record<string, unknown>;

type WireCall = { function?: { name?: unknown } };

/** Claude 가 받는 툴 이름. */
const CLAUDE_TOOL_NAME = /^[a-zA-Z0-9_-]{1,128}$/;

function callsOf(holder: unknown): WireCall[] {
  const calls = (holder as { tool_calls?: unknown } | null | undefined)?.tool_calls;
  return Array.isArray(calls) ? (calls as WireCall[]) : [];
}

/**
 * 네코의 툴 이름(todo.add, fs.read)엔 점이 있는데 Claude 는 `[a-zA-Z0-9_-]` 만 받아서
 * 요청 전체가 400 이 된다. 보낼 땐 바꾼 이름으로 보내고 돌아온 tool_calls 는 원래 이름으로
 * 되돌린다. 규칙(점→_)으로 되돌리지 않고 표를 쓰는 건, 바꾼 이름이 원래 있던 다른 툴
 * 이름(MCP 의 fs_read 같은)과 겹칠 수 있어서다. 본문만 보고 정하므로 같은 본문이면 언제나
 * 같은 표가 나온다. 반환: 원래 이름 → 보낼 이름(바꿀 게 있는 것만).
 */
export function claudeToolNames(body: Json): Map<string, string> {
  const names = new Set<string>();
  const add = (n: unknown) => { if (typeof n === "string") names.add(n); };
  for (const t of Array.isArray(body.tools) ? body.tools : []) add((t as WireCall)?.function?.name);
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    for (const c of callsOf(m)) add(c.function?.name);
    if ((m as Json)?.role === "tool") add((m as Json).name);
  }
  const taken = new Set([...names].filter((n) => CLAUDE_TOOL_NAME.test(n)));
  const map = new Map<string, string>();
  for (const n of names) {
    if (taken.has(n)) continue;
    const base = n.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "tool";
    let enc = base;
    for (let i = 2; taken.has(enc); i++) enc = `${base}_${i}`;
    taken.add(enc);
    map.set(n, enc);
  }
  return map;
}

/** Claude 의 오류 응답을 사용자가 할 일이 보이는 말로 바꾼다. 원문은 뒤에 남긴다(디버깅용). */
export function explainClaudeError(status: number, raw: string): string {
  const head =
    status === 401 || status === 403
      ? "Claude API 키가 맞지 않아. 설정 → 모델 프로필에서 다시 넣어줘."
      : /credit balance is too low/i.test(raw)
      ? "Claude API 크레딧이 바닥났어. 다음 결제일에 크레딧이 다시 들어오면 쓸 수 있어. Console 에서 auto-reload 를 안 켰다면 요금은 안 나가."
      : status === 429
      ? "Claude 요청이 너무 잦아서 잠깐 막혔어. 조금 있다가 다시 해줘."
      : status >= 500
      ? "Claude 서버가 지금 바빠. 잠시 후 다시 해줘."
      : "";
  const detail = raw.trim().slice(0, 400);
  return head ? `${head}\n(${detail})` : detail;
}

type ClaudeEvent =
  | { event: "head"; data: { status: number } }
  | { event: "chunk"; data: { text: string } }
  | { event: "end"; data?: undefined }
  | { event: "error"; data: { message: string } };

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("요청을 멈췄어.", "AbortError");
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function hasClaudeKey(): Promise<boolean> {
  try {
    return await invoke<boolean>("secret_has", { key: CLAUDE_KEY });
  } catch {
    return false;
  }
}

/** Rust 중계로 chat/completions 를 보내고, 그 응답을 표준 Response 로 돌려준다. */
/**
 * 나가기 전에 비밀을 가리고 홈 경로를 ~ 로 바꾼다(outbound-guard, lib/home). Claude 가 돌려준 블록 원본이 있는 턴은 손대지
 * 않는다 — 한 글자라도 바뀌면 생각 블록 서명이 깨진다. 거기 있는 건 Claude 가 이미 본 것이다.
 */
function redactMessage(m: Json): Json {
  if (m.anthropic_content) return m;
  const clean = (t: string) => redactSecrets(maskHome(t));
  if (typeof m.content === "string") return { ...m, content: clean(m.content) };
  if (!Array.isArray(m.content)) return m;
  return {
    ...m,
    content: (m.content as Json[]).map((p) => (p?.type === "text" && typeof p.text === "string" ? { ...p, text: clean(p.text) } : p)),
  };
}

async function claudeChat(model: string, init: RequestInit): Promise<Response> {
  const blocked = budgetBlockReason();
  if (blocked) throw new Error(blocked);

  const raw = JSON.parse(String(init.body ?? "{}")) as Json;
  if (Array.isArray(raw.messages)) raw.messages = (raw.messages as Json[]).map(redactMessage);
  const names = claudeToolNames(raw);
  const body = toMessagesRequest(raw, model, names);
  // Anthropic 쪽은 늘 스트림으로 받는다. 부른 쪽이 스트림을 안 원하면 끝에 JSON 한 덩이로 모아 준다.
  const stream = raw.stream === true;
  const adapter = createMessagesStreamAdapter(new Map([...names].map(([orig, enc]) => [enc, orig])));
  const id = crypto.randomUUID();
  const signal = init.signal ?? undefined;
  const encoder = new TextEncoder();

  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  const cancel = () => void invoke("claude_cancel", { id }).catch(() => {});
  const bodyStream = new ReadableStream<Uint8Array>({
    start(c) { ctrl = c; },
    // 소비자가 중간에 그만 읽으면(멈춤 버튼, generator return) 서버 쪽 생성도 끊는다.
    cancel() {
      if (!settled) cancel();
      settled = true;
    },
  });

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let status = 0;
    // 오류 응답은 본문을 끝까지 모아 사람이 읽을 말로 바꿔서 한 번에 돌려준다.
    let errorBody = "";

    const finish = () => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: Error) => {
      if (settled) return;
      finish();
      if (status && status < 400) ctrl.error(err);
      else reject(err);
    };
    const onAbort = () => {
      cancel();
      fail(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const channel = new Channel<ClaudeEvent>();
    channel.onmessage = (ev) => {
      if (settled) return;
      switch (ev.event) {
        case "head":
          status = ev.data.status;
          if (status < 400) {
            resolve(new Response(bodyStream, {
              status,
              headers: { "Content-Type": stream ? "text/event-stream" : "application/json" },
            }));
          }
          break;
        case "chunk":
          if (status >= 400) {
            errorBody += ev.data.text;
          } else {
            const out = adapter.push(ev.data.text);
            if (stream && out) ctrl.enqueue(encoder.encode(out));
          }
          break;
        case "end": {
          finish();
          if (status >= 400) {
            resolve(new Response(explainClaudeError(status, errorBody), { status }));
            break;
          }
          const rest = adapter.end();
          recordUsage(model, adapter.usage);
          if (import.meta.env.DEV && adapter.transformations.length) {
            // 생각 블록이 버려졌다 — 앞쪽 기록이 바뀌었다는 뜻이다(agent-context 의 appendOnly).
            console.warn("[claude] input_transformations", adapter.transformations);
          }
          if (adapter.error) {
            ctrl.error(new Error(adapter.error));
            break;
          }
          if (stream) {
            if (rest) ctrl.enqueue(encoder.encode(rest));
          } else {
            ctrl.enqueue(encoder.encode(JSON.stringify(adapter.completion())));
          }
          ctrl.close();
          break;
        }
        case "error":
          fail(new Error(ev.data.message));
          break;
      }
    };

    invoke("claude_chat", { id, body: JSON.stringify(body), onEvent: channel })
      .catch((e) => fail(new Error(String(e))));
  });
}

/**
 * 쓴 만큼 장부에 적는다. 캐시 쓰기는 입력값의 1.25배, 캐시 읽기는 0.1배라 그 차이를 더하고 뺀다.
 * 모르는 모델은 보정하지 않는다(가장 비싼 값으로 치는 estimateCostUsd 그대로).
 */
function recordUsage(model: string, u: MessagesUsage): void {
  const prompt = u.input + u.cacheWrite + u.cacheRead;
  if (prompt === 0 && u.output === 0) return;
  const p = findClaudeModel(model)?.price;
  const long = p?.longThreshold !== undefined && prompt > p.longThreshold;
  const rate = p ? (long ? p.longInput ?? p.input : p.input) / 1_000_000 : 0;
  useClaudeBudget.getState().record(model, prompt, u.output, rate * (u.cacheWrite * 0.25 - u.cacheRead * 0.9));
}

/**
 * Claude 에는 llama-server 의 상태 확인 엔드포인트가 없다. 네코가 기대하는 답을 여기서 만든다.
 * 키가 없으면 "안 떠 있는 서버"처럼 답해서, 설정의 연결 표시와 시작 시 경고가 그대로 동작한다.
 */
async function claudeLocal(model: string, path: string): Promise<Response> {
  switch (path) {
    case "/v1/models":
      return (await hasClaudeKey())
        ? jsonResponse({ object: "list", data: [{ id: model, object: "model" }] })
        : jsonResponse({ error: "Claude API 키가 없어." }, 503);
    case "/health":
      return (await hasClaudeKey()) ? jsonResponse({ status: "ok" }) : jsonResponse({ status: "no key" }, 503);
    case "/props":
      return jsonResponse({ n_ctx: claudeContextCap(model) });
    default:
      return jsonResponse({ error: `Claude 프로필에선 ${path} 를 쓸 수 없어.` }, 404);
  }
}

/**
 * 대화가 평문으로 네트워크를 지나는 주소인가. http 는 이 맥 안(loopback, SSH 터널 포함)과
 * Tailscale(WireGuard 로 이미 암호화된다)만 괜찮다 — 같은 와이파이의 누구나 대화를 읽는다.
 */
export function isPlainHttp(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== "http:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || /^127\./.test(host) || host.endsWith(".ts.net")) return false;
  const m = /^100\.(\d+)\./.exec(host);
  return !(m && +m[1] >= 64 && +m[1] <= 127); // 100.64.0.0/10 — Tailscale 주소
}

export const PLAIN_HTTP_HINT =
  "http 로는 대화가 암호화 없이 네트워크를 지나간다. https 주소를 쓰거나, " +
  "`ssh -L 8080:localhost:8080 서버` 로 터널을 열고 http://localhost:8080 에 붙거나, Tailscale 주소를 써.";

/**
 * `${base}${path}` 로 보내는 fetch 와 같다. base 를 안 주면 활성 프로필 주소다.
 * Claude 주소면 위의 중계로 돌린다. 평문 http 로 맥 밖에 보내는 건 막는다.
 */
export async function llmFetch(path: string, init: RequestInit = {}, base?: string): Promise<Response> {
  const url = base ?? useSettingsStore.getState().llmUrl;
  const model = claudeModelOf(url);
  if (!model && isPlainHttp(url)) throw new Error(`이 주소로는 보내지 않았어. ${PLAIN_HTTP_HINT}`);
  if (!model) return fetch(`${url}${path}`, init);
  if (path === "/v1/chat/completions") return claudeChat(model, init);
  return claudeLocal(model, path);
}

/**
 * Claude 의 내장 웹 검색. 지금 프로필이 Claude 일 때만 부른다(web.search 툴).
 *
 * 대화와 따로 가는 한 번짜리 요청이라 메인 대화의 전송 방식(OpenAI 호환 계층)은 그대로다.
 * 본문은 Rust 가 만든다 — 여기서 넘기는 건 모델·검색어·날짜뿐. 쓴 만큼 예산 장부에 적는다.
 * 실패하면 던진다: 부르는 쪽이 기존 검색으로 되돌아간다.
 */
export async function claudeWebSearch(query: string, today: string): Promise<NativeSearchResult> {
  if (!claudeModelOf(useSettingsStore.getState().llmUrl)) throw new Error("Claude 프로필이 아니야.");
  const model = WEB_SEARCH_MODEL;
  const blocked = budgetBlockReason();
  if (blocked) throw new Error(blocked);
  const r = await invoke<NativeSearchResult>("claude_web_search", { model, query, today });
  // 실패로 끝났어도 쓴 건 쓴 것이다. 장부부터 적는다.
  useClaudeBudget.getState().record(model, r.input_tokens, r.output_tokens, r.searches * WEB_SEARCH_USD);
  if (r.sources.length === 0 && r.errors.length > 0) throw new Error(`Claude 웹 검색 실패: ${r.errors.join(", ")}`);
  return r;
}

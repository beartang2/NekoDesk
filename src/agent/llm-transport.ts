import Anthropic from "@anthropic-ai/sdk";
import type { Stream } from "@anthropic-ai/sdk/core/streaming";
import { invoke } from "@tauri-apps/api/core";
import { abortError, claudeClient } from "./claude-sdk";
import { WEB_SEARCH_MODEL, WEB_SEARCH_USD, claudeModelOf, findClaudeModel } from "../lib/claude-models";
import { createMessagesStreamAdapter, toMessagesRequest, type MessagesUsage } from "./claude-messages";
import { redactSecrets } from "./outbound-guard";
import { maskHome } from "../lib/home";
import type { LlmMessage, NativeSearchResult } from "./types";
import { budgetBlockReason, useClaudeBudget } from "../stores/claudeBudget";
import { claudeContextFor, useSettingsStore } from "../stores/settingsStore";

/**
 * LLM 요청이 나가는 단 하나의 문.
 *
 * 로컬·외부 프로필이면 지금까지처럼 그 주소로 `fetch` 한다. Claude 프로필(`claude://모델`)이면
 * OpenAI 모양 요청을 Messages API 모양으로 바꿔(claude-messages) 공식 SDK 로 보낸다(claude-sdk —
 * 키는 Rust 중계가 붙인다). 받은 이벤트는 다시 OpenAI 모양으로 바꿔 표준 `Response` 로 돌려준다
 * — llm-client 의 파싱은 어느 쪽이든 같다.
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

/** 생각 블록이 앞쪽 기록과 안 맞을 때 400 대신 그 블록만 버리는 설정(`thinking.block_binding`)의 beta. */
const CHAT_BETA = "thinking-binding-controls-2026-08-01";

/** SDK 오류의 본문(있으면 API 가 준 JSON, 없으면 메시지). explainClaudeError 가 읽는다. */
function errorText(e: InstanceType<typeof Anthropic.APIError>): string {
  return e.error ? JSON.stringify(e.error) : e.message;
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
  const signal = init.signal ?? undefined;

  // 본문은 우리가 만든 Messages 모양 그대로다(block_binding 처럼 SDK 타입에 아직 없는 칸도 있다).
  const params = { ...body, stream: true, betas: [CHAT_BETA] } as unknown as Anthropic.Beta.Messages.MessageCreateParamsStreaming;
  let events: Stream<Anthropic.Beta.Messages.BetaRawMessageStreamEvent>;
  try {
    events = await claudeClient().beta.messages.create(params, { signal });
  } catch (e) {
    if (signal?.aborted) throw abortError(signal);
    // HTTP 오류는 지금까지처럼 상태코드가 붙은 응답으로 돌려준다 — llm-client 가 그걸 읽어 안내한다.
    if (e instanceof Anthropic.APIError && e.status) return new Response(explainClaudeError(e.status, errorText(e)), { status: e.status });
    throw e;
  }

  const encoder = new TextEncoder();
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    recordUsage(model, adapter.usage);
  };
  const out = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      try {
        for await (const ev of events) {
          const chunk = adapter.event(ev);
          if (stream && chunk) ctrl.enqueue(encoder.encode(chunk));
        }
        // SDK 스트림은 멈추면 오류 없이 그냥 끝난다. 읽는 쪽은 멈춘 걸 알아야 한다.
        if (signal?.aborted) throw abortError(signal);
        record();
        if (import.meta.env.DEV && adapter.transformations.length) {
          // 생각 블록이 버려졌다 — 앞쪽 기록이 바뀌었다는 뜻이다(agent-context 의 appendOnly).
          console.warn("[claude] input_transformations", adapter.transformations);
        }
        if (adapter.error) throw new Error(adapter.error);
        if (!stream) ctrl.enqueue(encoder.encode(JSON.stringify(adapter.completion())));
        ctrl.close();
      } catch (e) {
        // 멈췄거나 중간에 끊겨도 받은 만큼은 청구된다. 장부부터 적는다.
        record();
        ctrl.error(signal?.aborted ? abortError(signal) : e);
      }
    },
    // 소비자가 중간에 그만 읽으면(멈춤 버튼, generator return) 서버 쪽 생성도 끊는다.
    cancel() {
      events.controller.abort();
    },
  });
  return new Response(out, { status: 200, headers: { "Content-Type": stream ? "text/event-stream" : "application/json" } });
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
      return jsonResponse({ n_ctx: claudeContextFor(model) });
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

/** 서버 요약(on-demand compaction)의 beta. */
const COMPACT_BETA = "compact-2026-09-04";

/**
 * Anthropic 의 서버 요약으로 대화를 요약한다(밥 주기·자동 요약). 요약하는 프롬프트도 Anthropic 것이다.
 *
 * 돌아온 `compaction` 블록은 글만 꺼내 쓴다 — 네코는 요청마다 대화 기록을 글로 다시 짜므로, 블록을
 * 서명째 맨 앞에 붙여 다니는 대신 요약 글을 "이전 대화 요약" 메시지로 싣는다(로컬 모델로 바꿔도 같은
 * 요약이 쓰인다). 요약이 안 나오면(거절·잘림·도구 호출) null — 부르는 쪽이 다른 길로 요약한다.
 * 비밀·홈 경로는 다른 요청처럼 가리고 보낸다. 쓴 만큼 장부에 적는다.
 */
export async function claudeCompact(model: string, messages: LlmMessage[]): Promise<string | null> {
  const blocked = budgetBlockReason();
  if (blocked) throw new Error(blocked);
  const raw = { messages: (messages as unknown as Json[]).map(redactMessage) };
  const converted = toMessagesRequest(raw, model).messages;
  const res = await claudeClient().beta.messages.create({
    model,
    // 요약 앞의 생각까지 이 안에서 쓴다. 넉넉히.
    max_tokens: 8192,
    betas: [COMPACT_BETA],
    messages: converted,
    compaction: { type: "summarize" },
  } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
  // 요약 호출의 사용량은 usage.iterations 의 compaction 칸에 온다(맨 위 칸은 0).
  const iterations = (((res.usage as unknown as Json).iterations ?? []) as Json[]);
  const sum = (k: string) => iterations.reduce((n, it) => n + Number(it[k] ?? 0), 0);
  useClaudeBudget.getState().record(model, sum("input_tokens"), sum("output_tokens"), 0);
  if ((res.stop_reason as string) !== "compaction") return null;
  const block = (res.content as unknown as Json[]).find((b) => b.type === "compaction");
  const text = typeof block?.content === "string" ? block.content.trim() : "";
  return text || null;
}

/** 요청 하나에서 검색할 수 있는 횟수. 결과가 전부 입력 토큰이 되니 넉넉히 주지 않는다. */
const MAX_SEARCHES = 3;
/** 긴 검색은 pause_turn 으로 멈췄다 이어진다. 이만큼만 이어 보낸다. */
const MAX_CONTINUATIONS = 3;
const MAX_SOURCES = 10;

function searchSystem(today: string): string {
  return (
    `You are a web research helper for another assistant. Today is ${today}. ` +
    "Search the web for the user's query and report only facts found in the results, " +
    "each with its source title, URL and date when known. Prefer recent and primary sources. " +
    "If nothing relevant is found, say so plainly. Do not add facts from memory. " +
    "Answer in the language of the query."
  );
}

/** 응답 하나를 읽어 결과에 보탠다. 반환: 이어 보내야 하는가(pause_turn). */
export function absorbSearch(res: Json, out: NativeSearchResult): boolean {
  for (const block of (Array.isArray(res.content) ? res.content : []) as Json[]) {
    if (block.type === "text" && typeof block.text === "string") out.answer += block.text;
    if (block.type !== "web_search_tool_result") continue;
    if (!Array.isArray(block.content)) {
      // 실패는 200 안에 오류 객체로 온다(max_uses_exceeded·too_many_requests 등).
      out.errors.push(String((block.content as Json | undefined)?.error_code ?? "unknown"));
      continue;
    }
    for (const r of block.content as Json[]) {
      const url = String(r.url ?? "");
      if (!url || out.sources.some((s) => s.url === url) || out.sources.length >= MAX_SOURCES) continue;
      out.sources.push({ title: String(r.title ?? ""), url, page_age: typeof r.page_age === "string" ? r.page_age : null });
    }
  }
  const u = (res.usage ?? {}) as Json;
  out.input_tokens += Number(u.input_tokens ?? 0);
  out.output_tokens += Number(u.output_tokens ?? 0);
  out.searches += Number(((u.server_tool_use ?? {}) as Json).web_search_requests ?? 0);
  return res.stop_reason === "pause_turn";
}

/**
 * Claude 의 내장 웹 검색. 지금 프로필이 Claude 일 때만 부른다(web.search 툴).
 *
 * 대화와 따로 가는 한 번짜리 요청이다 — 검색어 하나짜리라 대화 기록과 엮인 생각 블록 검사에
 * 걸릴 일이 없다. 쓴 만큼 예산 장부에 적는다. 첫 요청부터 실패하면 던진다: 부르는 쪽이 기존
 * 검색으로 되돌아간다. 그 뒤의 실패는 errors 에 담아 쓴 만큼과 함께 돌려준다.
 */
export async function claudeWebSearch(query: string, today: string): Promise<NativeSearchResult> {
  if (!claudeModelOf(useSettingsStore.getState().llmUrl)) throw new Error("Claude 프로필이 아니야.");
  const model = WEB_SEARCH_MODEL;
  const blocked = budgetBlockReason();
  if (blocked) throw new Error(blocked);
  const q = query.trim().slice(0, 500);
  if (!q) throw new Error("검색어가 비어 있어.");

  const out: NativeSearchResult = { answer: "", sources: [], searches: 0, input_tokens: 0, output_tokens: 0, errors: [] };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: q }];
  for (let i = 0; i < MAX_CONTINUATIONS; i++) {
    let res: Anthropic.Message;
    try {
      res = await claudeClient().messages.create({
        model,
        max_tokens: 8000,
        system: searchSystem(today.slice(0, 60)),
        messages,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }],
      });
    } catch (e) {
      const status = e instanceof Anthropic.APIError && e.status ? e.status : 0;
      const msg = `Claude 웹 검색 실패(${status || "연결"}): ${e instanceof Error ? e.message : String(e)}`;
      // HTTP 오류 응답은 청구되지 않는다. 앞서 받은 게 있으면 그것만 돌려준다.
      if (out.input_tokens === 0) throw new Error(msg);
      out.errors.push(msg);
      break;
    }
    if (!absorbSearch(res as unknown as Json, out)) break;
    // 멈춘 턴은 받은 그대로 돌려보내야 이어진다(검색 결과의 암호화 본문 포함).
    messages.push({ role: "assistant", content: res.content });
  }
  // 실패로 끝났어도 쓴 건 쓴 것이다. 장부부터 적는다.
  useClaudeBudget.getState().record(model, out.input_tokens, out.output_tokens, out.searches * WEB_SEARCH_USD);
  if (out.sources.length === 0 && out.errors.length > 0) throw new Error(`Claude 웹 검색 실패: ${out.errors.join(", ")}`);
  return out;
}

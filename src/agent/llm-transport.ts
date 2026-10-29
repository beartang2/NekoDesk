import { Channel, invoke } from "@tauri-apps/api/core";
import { CLAUDE_CONTEXT_CAP, claudeModelOf } from "../lib/claude-models";
import { budgetBlockReason, useClaudeBudget } from "../stores/claudeBudget";
import { activeServerTools, useSettingsStore } from "../stores/settingsStore";
import { MessagesTranslator, RawTurnCache, toMessagesRequest } from "./claude-messages";

/**
 * LLM 요청이 나가는 단 하나의 문.
 *
 * 로컬 프로필이면 지금까지처럼 그 주소로 `fetch` 한다. Claude 프로필(`claude://모델`)이면
 * OpenAI 모양 본문을 네이티브 Messages API 본문으로 바꿔(claude-messages) Rust 의
 * `claude_chat` 으로 보낸다 — Rust 가 키체인의 키를 붙여 api.anthropic.com/v1/messages 로
 * 중계한다. 돌아온 Messages SSE 는 chat-completions SSE 로 번역해 표준 `Response` 로 감싼다.
 * 그래서 llm-client 의 파서는 어느 쪽이든 한 줄도 다르지 않다.
 */

/** 키체인 항목 이름. src-tauri/src/claude.rs 의 KEY_NAME 과 같아야 한다. */
export const CLAUDE_KEY = "anthropic_api_key";

export { CLAUDE_MIN_MAX_TOKENS } from "../lib/claude-models";
export { decodeToolName, encodeToolName } from "./tool-names";

type Json = Record<string, unknown>;

/** Claude 의 오류 응답을 사용자가 할 일이 보이는 말로 바꾼다. 원문은 뒤에 남긴다(디버깅용). */
export function explainClaudeError(status: number, raw: string): string {
  const head =
    status === 401 || status === 403
      ? "Claude API 키가 맞지 않아. 설정 → 모델 프로필에서 다시 넣어줘."
      : /credit balance is too low/i.test(raw)
      ? "Claude API 크레딧이 바닥났어. 다음 결제일에 크레딧이 다시 들어오면 쓸 수 있어. Console 에서 auto-reload 를 안 켰다면 요금은 안 나가."
      : status === 429
      ? "Claude 요청이 너무 잦아서 잠깐 막혔어. 조금 있다가 다시 해줘."
      : status === 529 || status >= 500
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

/** 응답 원본 블록. 툴 호출 턴의 thinking·서버 툴 블록을 다음 요청에 그대로 되돌려 보내야 한다. */
const rawTurns = new RawTurnCache();

/** pause_turn(서버 툴 반복 상한)을 이어 가는 최대 횟수. 그 뒤엔 받은 데까지로 답한다. */
const MAX_CONTINUATIONS = 3;

/** HTTP 오류. 상태코드를 들고 있어 첫 바이트 전이면 그 코드의 Response 로 돌려줄 수 있다. */
class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

/**
 * Rust 중계로 Messages 요청 하나를 보낸다. 본문 조각은 `onChunk` 로, 끝은 resolve 로.
 * HTTP 오류는 본문을 모아 HttpError 로 던진다. 멈춤은 `signal` 로.
 */
function postMessages(body: Json, signal: AbortSignal | undefined, onChunk: (text: string) => void): Promise<void> {
  const id = crypto.randomUUID();
  const cancel = () => void invoke("claude_cancel", { id }).catch(() => {});
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(abortError(signal)); return; }
    let status = 0;
    let errorBody = "";
    let settled = false;
    const finish = () => { settled = true; signal?.removeEventListener("abort", onAbort); };
    const onAbort = () => { if (settled) return; cancel(); finish(); reject(abortError(signal!)); };
    signal?.addEventListener("abort", onAbort, { once: true });

    const channel = new Channel<ClaudeEvent>();
    channel.onmessage = (ev) => {
      if (settled) return;
      switch (ev.event) {
        case "head":
          status = ev.data.status;
          break;
        case "chunk":
          if (status >= 400) errorBody += ev.data.text;
          else {
            try { onChunk(ev.data.text); } catch (e) { finish(); cancel(); reject(e instanceof Error ? e : new Error(String(e))); }
          }
          break;
        case "end":
          finish();
          if (status >= 400) reject(new HttpError(status, explainClaudeError(status, errorBody)));
          else resolve();
          break;
        case "error":
          finish();
          reject(new Error(ev.data.message));
          break;
      }
    };
    invoke("claude_chat", { id, body: JSON.stringify(body), onEvent: channel })
      .catch((e) => { if (!settled) { finish(); reject(new Error(String(e))); } });
  });
}

/**
 * chat/completions 요청(OpenAI 모양) → Messages API → chat/completions 응답(OpenAI 모양).
 *
 * 스트리밍이면 번역된 SSE 를 ReadableStream 으로 흘리고, 아니면 다 모아 JSON 한 덩이로 준다.
 * pause_turn 이 오면 받은 assistant 블록을 그대로 되돌려 보내 이어 간다(출력은 끊기지 않는다).
 */
async function claudeChat(model: string, init: RequestInit): Promise<Response> {
  const blocked = budgetBlockReason();
  if (blocked) throw new Error(blocked);

  const openai = JSON.parse(String(init.body ?? "{}")) as Json;
  const wantStream = openai.stream === true;
  const outer = init.signal ?? undefined;
  const request = toMessagesRequest(openai, {
    model,
    serverTools: activeServerTools(),
    rawCache: rawTurns,
    timezone: safeTimezone(),
  });
  const translator = new MessagesTranslator();

  // 한 메시지(message_start…message_stop)씩 받아 번역한다. 번역된 SSE 는 sink 로 간다.
  const runLoop = async (sig: AbortSignal | undefined, sink: (sse: string) => void): Promise<void> => {
    let messages = request.messages as unknown[];
    for (let round = 0; round <= MAX_CONTINUATIONS; round++) {
      if (round > 0) translator.beginNextMessage();
      await postMessages({ ...request, messages }, sig, (text) => sink(translator.feed(text)));
      sink(translator.flush());
      if (translator.rawContent.length) rawTurns.remember(translator.rawContent);
      if (translator.stop !== "pause_turn") break;
      // 서버 툴 반복 상한에 걸렸다. 받은 assistant 내용을 그대로 붙여 다시 보낸다.
      messages = [...messages, { role: "assistant", content: translator.rawContent }];
    }
    sink(translator.finish());
    const u = translator.usageTotals;
    useClaudeBudget.getState().record(model, u.input + u.cacheRead + u.cacheWrite, u.output, {
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      webSearches: u.webSearches,
    });
  };

  if (!wantStream) {
    try {
      await runLoop(outer, () => {});
    } catch (e) {
      if (e instanceof HttpError) return new Response(e.message, { status: e.status });
      throw e;
    }
    return jsonResponse(translator.aggregate());
  }

  // 소비자가 끊으면(멈춤 버튼, generator return) 서버 쪽 생성도 끊는다. 바깥 signal 과 스트림
  // cancel 을 하나의 안쪽 컨트롤러로 모은다.
  const inner = new AbortController();
  outer?.addEventListener("abort", () => inner.abort(outer.reason), { once: true });
  const encoder = new TextEncoder();
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) { ctrl = c; },
    cancel() { closed = true; inner.abort(new DOMException("요청을 멈췄어.", "AbortError")); },
  });

  // 첫 바이트가 오기 전에 HTTP 오류가 나면 그 상태코드의 Response 로 — llm-client 가 400 을 읽는다.
  let headed = false;
  let resolveHead!: (r: Response) => void;
  let rejectHead!: (e: Error) => void;
  const head = new Promise<Response>((res, rej) => { resolveHead = res; rejectHead = rej; });
  const openHead = () => {
    if (headed) return;
    headed = true;
    resolveHead(new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } }));
  };

  void (async () => {
    try {
      await runLoop(inner.signal, (sse) => {
        openHead();
        if (!closed && sse) ctrl.enqueue(encoder.encode(sse));
      });
      openHead();
      if (!closed) { closed = true; ctrl.close(); }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (!headed) {
        headed = true;
        if (err instanceof HttpError) resolveHead(new Response(err.message, { status: err.status }));
        else rejectHead(err);
      } else if (!closed) {
        closed = true;
        ctrl.error(err);
      }
    }
  })();
  return head;
}

function safeTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
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
      return jsonResponse({ n_ctx: CLAUDE_CONTEXT_CAP });
    default:
      return jsonResponse({ error: `Claude 프로필에선 ${path} 를 쓸 수 없어.` }, 404);
  }
}

/**
 * `${base}${path}` 로 보내는 fetch 와 같다. base 를 안 주면 활성 프로필 주소다.
 * Claude 주소면 위의 중계로 돌린다.
 */
export async function llmFetch(path: string, init: RequestInit = {}, base?: string): Promise<Response> {
  const url = base ?? useSettingsStore.getState().llmUrl;
  const model = claudeModelOf(url);
  if (!model) return fetch(`${url}${path}`, init);
  if (path === "/v1/chat/completions") return claudeChat(model, init);
  return claudeLocal(model, path);
}

/** 테스트용: 되돌려 보낼 원본 블록 캐시. */
export const __rawTurnsForTest = rawTurns;

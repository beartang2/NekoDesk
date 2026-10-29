import { Channel, invoke } from "@tauri-apps/api/core";
import { CLAUDE_CONTEXT_CAP, claudeModelOf } from "../lib/claude-models";
import { budgetBlockReason, useClaudeBudget } from "../stores/claudeBudget";
import { useSettingsStore } from "../stores/settingsStore";

/**
 * LLM 요청이 나가는 단 하나의 문.
 *
 * 로컬 프로필이면 지금까지처럼 그 주소로 `fetch` 한다. Claude 프로필(`claude://모델`)이면
 * Rust 의 `claude_chat` 이 키체인의 키를 붙여 api.anthropic.com 으로 중계하고, 그 결과를
 * 표준 `Response` 로 감싸 돌려준다. 그래서 llm-client 의 SSE·JSON 파싱은 어느 쪽이든
 * 한 줄도 다르지 않다 — Anthropic 의 OpenAI 호환 계층이 llama-server 와 같은 모양으로 답한다.
 */

/** 키체인 항목 이름. src-tauri/src/claude.rs 의 KEY_NAME 과 같아야 한다. */
export const CLAUDE_KEY = "anthropic_api_key";

/**
 * Claude 로 보낼 때 max_tokens 의 바닥. Claude 5 모델은 적응형 생각이 기본으로 켜져 있고
 * 생각 토큰도 max_tokens 에 포함된다. 끝말잇기(20)·기억 판정(8)처럼 아주 짧게 잡은 호출은
 * 생각만 하다 잘려 답이 비어 버린다. 실제로 쓴 만큼만 청구되므로 바닥을 올려도 비용은 그대로다.
 */
export const CLAUDE_MIN_MAX_TOKENS = 4096;

/**
 * llama.cpp 전용이거나, 최신 Claude 가 400 을 내는 필드.
 * temperature·top_p 는 Claude 4.7 이후 모델에서 기본값이 아니면 오류다(Haiku 5.5 문서: 빼라).
 */
const DROP_FIELDS = [
  "grammar",
  "chat_template_kwargs",
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "cache_prompt",
  "id_slot",
  "n_probs",
  "samplers",
] as const;

type Json = Record<string, unknown>;

function sanitizeMessage(m: unknown): unknown {
  if (!m || typeof m !== "object") return m;
  const msg = m as Json;
  // 툴만 부르고 말은 없던 턴. 빈 문자열을 그대로 보내면 빈 텍스트 블록이 돼 Claude 가 거부한다.
  if (msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0 && !msg.content) {
    return { ...msg, content: null };
  }
  return m;
}

/** llama-server 용으로 조립한 본문을 Claude 호환 엔드포인트가 받는 모양으로 바꾼다. */
export function toClaudeBody(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  for (const k of DROP_FIELDS) delete out[k];
  const max = typeof body.max_tokens === "number" ? body.max_tokens : 0;
  out.max_tokens = Math.max(max, CLAUDE_MIN_MAX_TOKENS);
  if (Array.isArray(body.messages)) out.messages = body.messages.map(sanitizeMessage);
  return out;
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

/**
 * 응답에서 usage 를 엿본다. 스트림이면 `data:` 줄마다, 아니면 끝나고 JSON 한 덩이에서.
 * 마지막에 본 값을 쓴다 — usage 가 여러 번 오면 마지막이 누적값이다.
 */
export function createUsageTap(stream: boolean) {
  let buf = "";
  let last: { prompt: number; completion: number } | null = null;

  const take = (obj: unknown) => {
    const u = (obj as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null)?.usage;
    if (u && typeof u.prompt_tokens === "number") {
      last = { prompt: u.prompt_tokens, completion: typeof u.completion_tokens === "number" ? u.completion_tokens : 0 };
    }
  };

  const scanLines = (flush: boolean) => {
    const lines = buf.split("\n");
    buf = flush ? "" : lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]" || !payload.includes('"usage"')) continue;
      try { take(JSON.parse(payload)); } catch { /* 깨진 줄은 llm-client 도 건너뛴다 */ }
    }
  };

  return {
    push(text: string) {
      buf += text;
      if (stream) scanLines(false);
    },
    /** 끝까지 받았을 때 한 번. 본 usage 를 돌려준다. */
    end(): { prompt: number; completion: number } | null {
      if (stream) scanLines(true);
      else {
        try { take(JSON.parse(buf)); } catch { /* JSON 이 아니면 usage 도 없다 */ }
      }
      return last;
    },
  };
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
async function claudeChat(model: string, init: RequestInit): Promise<Response> {
  const blocked = budgetBlockReason();
  if (blocked) throw new Error(blocked);

  const body = toClaudeBody(JSON.parse(String(init.body ?? "{}")) as Json, model);
  const stream = body.stream === true;
  const id = crypto.randomUUID();
  const signal = init.signal ?? undefined;
  const encoder = new TextEncoder();
  const tap = createUsageTap(stream);

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
            tap.push(ev.data.text);
            ctrl.enqueue(encoder.encode(ev.data.text));
          }
          break;
        case "end": {
          finish();
          if (status >= 400) {
            resolve(new Response(explainClaudeError(status, errorBody), { status }));
            break;
          }
          const usage = tap.end();
          if (usage) useClaudeBudget.getState().record(model, usage.prompt, usage.completion);
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

/**
 * Claude 네이티브 Messages API 변환기.
 *
 * llm-client 는 OpenAI 모양(messages/tools/chat-completions SSE)만 안다. 여기서
 *  - 나갈 때: OpenAI 본문 → `/v1/messages` 본문 (`toMessagesRequest`)
 *  - 들어올 때: Messages SSE 이벤트 → chat-completions SSE 청크 (`MessagesTranslator`)
 * 로 바꾼다. 그래서 llm-client 의 파서는 한 줄도 안 바뀌고, 캐싱·effort·서버 툴(웹 검색)·
 * 거절 처리 같은 네이티브 기능을 쓴다.
 *
 * 순수 함수·순수 상태 기계만 둔다. 네트워크·Tauri 는 llm-transport 가 맡는다.
 *
 * ## 되돌려 보내야 하는 블록
 * Haiku 5.5 는 툴 호출 턴에서 **thinking 블록(signature 포함)을 그대로** 되돌려 받아야 한다.
 * 수정하면 400 이다. 서버 툴 블록(web_search_tool_result 의 encrypted_content)도 같다.
 * 우리 이력은 OpenAI 모양이라 그 블록이 없으므로, 응답의 원본 content 를 tool_use id 로
 * 기억해 뒀다가(`RawTurnCache`) 이력의 assistant 메시지를 그 원본으로 바꿔치기한다.
 */

import { CLAUDE_MIN_MAX_TOKENS } from "../lib/claude-models";
import { encodeToolName, resetToolNames } from "./tool-names";

type Json = Record<string, unknown>;

export interface ServerToolSpec {
  type: string;
  name: string;
  [k: string]: unknown;
}

export interface MessagesRequestOptions {
  model: string;
  serverTools: ServerToolSpec[];
  rawCache: RawTurnCache;
  /** 주소 힌트(web_search 의 user_location). 없으면 안 보낸다. */
  timezone?: string;
}

/** 응답 원본 content 블록. tool_use id 마다 그 응답 전체를 가리킨다. */
export class RawTurnCache {
  private readonly byToolId = new Map<string, unknown[]>();
  private readonly order: string[] = [];
  constructor(private readonly limit = 200) {}

  remember(content: unknown[]): void {
    const ids = content
      .filter((b): b is { type: string; id: string } => {
        const x = b as { type?: string; id?: unknown };
        return (x.type === "tool_use" || x.type === "server_tool_use") && typeof x.id === "string";
      })
      .map((b) => b.id);
    for (const id of ids) {
      if (!this.byToolId.has(id)) this.order.push(id);
      this.byToolId.set(id, content);
    }
    while (this.order.length > this.limit) {
      const old = this.order.shift()!;
      this.byToolId.delete(old);
    }
  }

  /** 이 tool_use id 들을 낳은 응답의 원본. 하나라도 알면 그 응답이다. */
  lookup(toolIds: string[]): unknown[] | null {
    for (const id of toolIds) {
      const raw = this.byToolId.get(id);
      if (raw) return raw;
    }
    return null;
  }
}

// ── 요청 ─────────────────────────────────────────────────────────────────────

function dataUrlToImage(url: string): Json {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
  return { type: "image", source: { type: "url", url } };
}

function userBlocks(content: unknown): Json[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Json[] = [];
  for (const part of content as Array<{ type?: string; text?: string; image_url?: { url?: string } }>) {
    if (part.type === "text" && part.text) out.push({ type: "text", text: part.text });
    else if (part.type === "image_url" && part.image_url?.url) out.push(dataUrlToImage(part.image_url.url));
  }
  return out;
}

function assistantBlocks(
  msg: { content?: unknown; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> },
  cache: RawTurnCache
): unknown[] {
  const calls = msg.tool_calls ?? [];
  if (calls.length) {
    const raw = cache.lookup(calls.map((c) => c.id));
    if (raw) return raw;
  }
  const out: Json[] = [];
  const text = typeof msg.content === "string" ? msg.content : "";
  if (text.trim()) out.push({ type: "text", text });
  for (const c of calls) {
    let input: unknown = {};
    try { input = c.function.arguments ? JSON.parse(c.function.arguments) : {}; } catch { input = {}; }
    out.push({ type: "tool_use", id: c.id, name: encodeToolName(c.function.name), input });
  }
  return out;
}

function toolResultBlock(msg: { tool_call_id?: string; content?: unknown }): Json {
  const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? "");
  return { type: "tool_result", tool_use_id: msg.tool_call_id ?? "", content: text };
}

/**
 * OpenAI 모양 본문 → Messages API 본문.
 *
 * - system 메시지는 전부 top-level `system` 으로(호환 레이어와 같은 규칙).
 * - 같은 역할이 이어지면 한 메시지로 합친다. 특히 **툴 결과 여러 개는 user 메시지 하나**에
 *   넣어야 병렬 호출이 유지된다(나누면 모델이 병렬을 덜 하게 된다).
 * - 툴 결과 뒤에 온 사용자 말(끼어든 말)은 같은 user 메시지의 text 블록으로 붙는다 —
 *   Haiku 5.5 는 tool_result 안의 지시를 인젝션으로 의심하므로 밖에 둬야 한다.
 * - 빈 user 블록은 API 가 거부한다. 비면 자리 표시를 넣는다.
 */
export function toMessagesRequest(body: Json, opts: MessagesRequestOptions): Json {
  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: unknown[] }> = [];

  const push = (role: "user" | "assistant", blocks: unknown[]) => {
    // 빈 assistant 는 API 가 거부하니 뺀다. 빈 user 는 자리를 남겨 두고 아래서 자리 표시를 넣는다.
    if (!blocks.length && role === "assistant") return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };

  for (const m of (body.messages as Array<Json> | undefined) ?? []) {
    const role = m.role as string;
    if (role === "system") {
      const c = m.content;
      if (typeof c === "string" && c.trim()) systemParts.push(c);
    } else if (role === "user") {
      push("user", userBlocks(m.content));
    } else if (role === "assistant") {
      push("assistant", assistantBlocks(m as Parameters<typeof assistantBlocks>[0], opts.rawCache));
    } else if (role === "tool") {
      push("user", [toolResultBlock(m as { tool_call_id?: string; content?: unknown })]);
    }
  }
  // 첫 메시지는 user 여야 한다. 이력이 assistant 로 시작하면(요약 턴 등) 자리 표시를 앞세운다.
  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: [{ type: "text", text: "(이어서)" }] });
  }
  for (const m of messages) {
    if (m.role === "user" && m.content.length === 0) m.content.push({ type: "text", text: "(빈 메시지)" });
  }

  const tools: unknown[] = [];
  if (Array.isArray(body.tools)) resetToolNames();
  for (const t of (body.tools as Array<{ function?: { name?: string; description?: string; parameters?: unknown } }> | undefined) ?? []) {
    if (!t.function?.name) continue;
    tools.push({
      name: encodeToolName(t.function.name),
      description: t.function.description ?? "",
      input_schema: t.function.parameters ?? { type: "object", properties: {} },
    });
  }
  for (const s of opts.serverTools) {
    const spec: Json = { ...s };
    if (s.name === "web_search" && opts.timezone && !("user_location" in spec)) {
      spec.user_location = { type: "approximate", timezone: opts.timezone };
    }
    tools.push(spec);
  }

  const max = typeof body.max_tokens === "number" ? body.max_tokens : 0;
  const out: Json = {
    model: opts.model,
    max_tokens: Math.max(max, CLAUDE_MIN_MAX_TOKENS),
    stream: true,
    // 자동 캐싱 — tools → system → messages 순으로 바뀌지 않은 앞부분을 다시 쓴다.
    cache_control: { type: "ephemeral" },
    messages,
  };
  if (systemParts.length) out.system = systemParts.join("\n");
  if (tools.length) {
    out.tools = tools;
    out.tool_choice = { type: "auto" };
  }
  // 생각: 단발 작업(판정·게임·번역)은 끄고, 나머지는 모델이 깊이를 정한다(adaptive).
  out.thinking = body.neko_thinking_off === true ? { type: "disabled" } : { type: "adaptive" };
  const effort = body.neko_effort;
  if (effort === "low" || effort === "medium" || effort === "high") {
    out.output_config = { effort };
  }
  return out;
}

// ── 응답 ─────────────────────────────────────────────────────────────────────

export interface TranslatedUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  webSearches: number;
}

export interface Source {
  url: string;
  title: string;
}

interface BlockState {
  type: string;
  id?: string;
  name?: string;
  partialJson: string;
  /** OpenAI tool_calls 의 index. tool_use 블록에만 있다. */
  callIndex?: number;
  text: string;
  thinking: string;
  signature: string;
  /** 서버 툴 결과·기타 블록은 원본 그대로 보관한다(되돌려 보내야 한다). */
  raw?: unknown;
}

/**
 * Messages SSE → chat-completions SSE 번역기. 메시지 하나(message_start … message_stop)가
 * 단위이고, pause_turn 이면 같은 번역기로 다음 메시지를 이어 받는다(출력은 끊기지 않는다).
 */
export class MessagesTranslator {
  private buf = "";
  private blocks = new Map<number, BlockState>();
  private nextCallIndex = 0;
  private usage: TranslatedUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, webSearches: 0 };
  private stopReason: string | null = null;
  private stopDetails: unknown = null;
  private sources: Source[] = [];
  private content: unknown[] = [];
  private messageDone = false;
  /** 비스트리밍 응답을 만들려고 모아 둔다. */
  private fullText = "";
  private fullReasoning = "";
  private fullCalls: Array<{ id: string; name: string; arguments: string }> = [];

  /** SSE 조각을 먹이고, 내보낼 chat-completions SSE 텍스트를 돌려준다. */
  feed(text: string): string {
    this.buf += text;
    const out: string[] = [];
    // SSE 는 빈 줄로 이벤트를 나눈다. 마지막 조각은 다음에 이어 붙인다.
    const events = this.buf.split(/\r?\n\r?\n/);
    this.buf = events.pop() ?? "";
    for (const ev of events) {
      for (const line of ev.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        let data: Json;
        try { data = JSON.parse(payload) as Json; } catch { continue; }
        out.push(...this.handle(data));
      }
    }
    return out.join("");
  }

  /** 남은 조각까지 처리한다. 스트림이 끝났을 때 한 번. */
  flush(): string {
    const rest = this.buf;
    this.buf = "";
    return rest.trim() ? this.feed(rest + "\n\n") : "";
  }

  get isMessageDone(): boolean { return this.messageDone; }
  get stop(): string | null { return this.stopReason; }
  get details(): unknown { return this.stopDetails; }
  get rawContent(): unknown[] { return this.content; }
  get usageTotals(): TranslatedUsage { return this.usage; }
  get citedSources(): Source[] { return this.sources; }

  /** 다음 메시지(pause_turn 이어가기)를 받을 준비. 사용량·출처는 누적한다. */
  beginNextMessage(): void {
    this.blocks = new Map();
    this.content = [];
    this.stopReason = null;
    this.stopDetails = null;
    this.messageDone = false;
  }

  /** 마지막 청크: usage 와 [DONE]. 거절이면 사람이 읽을 한 줄을 먼저 흘린다. */
  finish(): string {
    const out: string[] = [];
    if (this.stopReason === "refusal") {
      const cat = (this.stopDetails as { category?: string } | null)?.category;
      out.push(this.chunk({ content: `이 요청은 안전 정책 때문에 처리하지 않았어${cat ? ` (${cat})` : ""}. 다른 방식으로 물어봐 줘.` }, "stop"));
    }
    const src = this.sourcesFooter();
    if (src) out.push(this.chunk({ content: src }, null));
    const prompt = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;
    out.push(`data: ${JSON.stringify({
      choices: [],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: this.usage.output,
        total_tokens: prompt + this.usage.output,
        cache_read_input_tokens: this.usage.cacheRead,
        cache_creation_input_tokens: this.usage.cacheWrite,
        web_search_requests: this.usage.webSearches,
      },
    })}\n\n`);
    out.push("data: [DONE]\n\n");
    return out.join("");
  }

  /** 비스트리밍 호출을 위한 chat-completions JSON 한 덩이. */
  aggregate(): Json {
    const prompt = this.usage.input + this.usage.cacheRead + this.usage.cacheWrite;
    let text = this.fullText;
    if (this.stopReason === "refusal") {
      const cat = (this.stopDetails as { category?: string } | null)?.category;
      text += `이 요청은 안전 정책 때문에 처리하지 않았어${cat ? ` (${cat})` : ""}.`;
    }
    text += this.sourcesFooter();
    return {
      choices: [{
        message: {
          role: "assistant",
          content: text,
          reasoning_content: this.fullReasoning,
          tool_calls: this.fullCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
        },
        finish_reason: this.fullCalls.length ? "tool_calls" : "stop",
      }],
      usage: {
        prompt_tokens: prompt,
        completion_tokens: this.usage.output,
        total_tokens: prompt + this.usage.output,
        cache_read_input_tokens: this.usage.cacheRead,
        cache_creation_input_tokens: this.usage.cacheWrite,
        web_search_requests: this.usage.webSearches,
      },
    };
  }

  private sourcesFooter(): string {
    if (!this.sources.length) return "";
    const lines = this.sources.slice(0, 8).map((s) => `- [${s.title || s.url}](${s.url})`);
    return `\n\n출처:\n${lines.join("\n")}`;
  }

  private chunk(delta: Json, finish: string | null): string {
    return `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
  }

  private addSource(url: unknown, title: unknown): void {
    if (typeof url !== "string" || !url) return;
    if (this.sources.some((s) => s.url === url)) return;
    this.sources.push({ url, title: typeof title === "string" ? title : "" });
  }

  private takeUsage(u: Json | undefined): void {
    if (!u) return;
    if (typeof u.input_tokens === "number") this.usage.input = u.input_tokens;
    if (typeof u.cache_read_input_tokens === "number") this.usage.cacheRead = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") this.usage.cacheWrite = u.cache_creation_input_tokens;
    if (typeof u.output_tokens === "number") this.usage.output = u.output_tokens;
    const st = u.server_tool_use as { web_search_requests?: number } | undefined;
    if (typeof st?.web_search_requests === "number") this.usage.webSearches = st.web_search_requests;
  }

  private handle(data: Json): string[] {
    const out: string[] = [];
    switch (data.type) {
      case "message_start": {
        const msg = data.message as Json | undefined;
        // pause_turn 으로 이어지는 두 번째 메시지의 입력은 누적한다(둘 다 청구된다).
        const prev = { ...this.usage };
        this.takeUsage(msg?.usage as Json | undefined);
        this.usage.input += prev.input;
        this.usage.cacheRead += prev.cacheRead;
        this.usage.cacheWrite += prev.cacheWrite;
        this.usage.output = prev.output;
        break;
      }
      case "content_block_start": {
        const index = data.index as number;
        const cb = (data.content_block ?? {}) as Json;
        const type = String(cb.type ?? "");
        const st: BlockState = { type, partialJson: "", text: "", thinking: "", signature: "" };
        if (type === "tool_use") {
          st.id = String(cb.id ?? "");
          st.name = String(cb.name ?? "");
          st.callIndex = this.nextCallIndex++;
          out.push(this.chunk({ tool_calls: [{ index: st.callIndex, id: st.id, type: "function", function: { name: st.name, arguments: "" } }] }, null));
        } else if (type === "server_tool_use") {
          st.id = String(cb.id ?? "");
          st.name = String(cb.name ?? "");
        } else if (type === "web_search_tool_result" || type === "web_fetch_tool_result") {
          st.raw = cb;
          const items = Array.isArray(cb.content) ? (cb.content as Json[]) : [];
          for (const it of items) {
            if (it.type === "web_search_result") this.addSource(it.url, it.title);
          }
          // 결과 하나(web_fetch)는 content 가 객체다.
          const one = cb.content as Json | undefined;
          if (one && !Array.isArray(one) && one.type === "web_fetch_result") this.addSource(one.url, (one.content as Json | undefined)?.title);
        } else if (type === "text" && typeof cb.text === "string" && cb.text) {
          st.text = cb.text;
          this.fullText += cb.text;
          out.push(this.chunk({ content: cb.text }, null));
        } else if (type !== "thinking" && type !== "text") {
          st.raw = cb;
        }
        this.blocks.set(index, st);
        break;
      }
      case "content_block_delta": {
        const st = this.blocks.get(data.index as number);
        const d = (data.delta ?? {}) as Json;
        if (!st) break;
        if (d.type === "text_delta" && typeof d.text === "string") {
          st.text += d.text;
          this.fullText += d.text;
          out.push(this.chunk({ content: d.text }, null));
        } else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
          st.thinking += d.thinking;
          if (d.thinking) {
            this.fullReasoning += d.thinking;
            out.push(this.chunk({ reasoning_content: d.thinking }, null));
          }
        } else if (d.type === "signature_delta" && typeof d.signature === "string") {
          st.signature += d.signature;
        } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
          st.partialJson += d.partial_json;
          if (st.callIndex !== undefined && d.partial_json) {
            out.push(this.chunk({ tool_calls: [{ index: st.callIndex, function: { arguments: d.partial_json } }] }, null));
          }
        } else if (d.type === "citations_delta") {
          const c = d.citation as Json | undefined;
          if (c) this.addSource(c.url, c.title);
        }
        break;
      }
      case "content_block_stop": {
        const index = data.index as number;
        const st = this.blocks.get(index);
        if (!st) break;
        // 원본 블록 조립 — 되돌려 보낼 때 그대로 쓴다.
        if (st.type === "text") {
          if (st.text) this.content.push({ type: "text", text: st.text });
        } else if (st.type === "thinking") {
          this.content.push({ type: "thinking", thinking: st.thinking, signature: st.signature });
        } else if (st.type === "tool_use" || st.type === "server_tool_use") {
          let input: unknown = {};
          try { input = st.partialJson ? JSON.parse(st.partialJson) : {}; } catch { input = {}; }
          this.content.push({ type: st.type, id: st.id, name: st.name, input });
          if (st.type === "tool_use") {
            this.fullCalls.push({ id: st.id ?? "", name: st.name ?? "", arguments: st.partialJson || "{}" });
          } else {
            // 서버 툴이 돈 걸 "생각 중" 칸에 보여준다. 답 본문엔 안 섞는다.
            const q = (input as { query?: string; url?: string });
            const note = st.name === "web_search" ? `🔎 웹 검색: ${q.query ?? ""}` : st.name === "web_fetch" ? `📄 페이지 읽기: ${q.url ?? ""}` : `⚙️ ${st.name}`;
            out.push(this.chunk({ reasoning_content: `${note}\n` }, null));
          }
        } else if (st.raw !== undefined) {
          this.content.push(st.raw);
        }
        break;
      }
      case "message_delta": {
        const delta = (data.delta ?? {}) as Json;
        if (typeof delta.stop_reason === "string") this.stopReason = delta.stop_reason;
        if (delta.stop_details !== undefined) this.stopDetails = delta.stop_details;
        this.takeUsage(data.usage as Json | undefined);
        break;
      }
      case "message_stop": {
        this.messageDone = true;
        if (this.stopReason === "tool_use") out.push(this.chunk({}, "tool_calls"));
        else if (this.stopReason === "max_tokens") out.push(this.chunk({}, "length"));
        else if (this.stopReason && this.stopReason !== "pause_turn" && this.stopReason !== "refusal") out.push(this.chunk({}, "stop"));
        break;
      }
      case "error": {
        const err = (data.error ?? {}) as Json;
        throw new Error(`Claude 스트림 오류: ${String(err.type ?? "")} ${String(err.message ?? "")}`.trim());
      }
      default:
        break; // ping, 모르는 이벤트
    }
    return out;
  }
}

/**
 * OpenAI chat/completions 모양 ↔ Anthropic Messages API 모양.
 *
 * 네코의 요청·파싱(llm-client)은 llama-server 의 OpenAI 모양으로 짜여 있다. Claude 프로필만
 * 네이티브 Messages API 로 보내려고, 전송 계층에서 요청을 바꿔 보내고 받은 스트림을 다시
 * OpenAI 모양으로 바꿔 돌려준다. 그래서 llm-client 와 그 위는 Claude 인지 모른다.
 *
 * 네이티브로 가는 이유: 프롬프트 캐싱(시스템 프롬프트·툴 정의를 매 턴 0.1배로 읽는다),
 * 생각 요약을 받아 화면에 보이기, 생각 블록을 다음 턴에 그대로 돌려주기. OpenAI 호환 계층은
 * 셋 다 못 한다.
 */

type Json = Record<string, unknown>;
type Block = Json;

/** 끝말잇기(20)·기억 판정(8)처럼 짧게 잡은 호출도 생각이 max_tokens 를 먹으므로 바닥을 둔다. */
export const CLAUDE_MIN_MAX_TOKENS = 4096;

interface WireCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

function parseArgs(raw: unknown): Json {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
  } catch {
    return {};
  }
}

/** data URL 이면 base64 블록, 아니면 URL 블록. */
function imageBlock(url: string): Block {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m
    ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }
    : { type: "image", source: { type: "url", url } };
}

function contentBlocks(content: unknown): Block[] {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  return content.flatMap((p: Json): Block[] => {
    if (p?.type === "text" && typeof p.text === "string" && p.text) return [{ type: "text", text: p.text }];
    const url = (p?.image_url as { url?: unknown } | undefined)?.url;
    if (p?.type === "image_url" && typeof url === "string") return [imageBlock(url)];
    return [];
  });
}

function textOf(content: unknown): string {
  return contentBlocks(content)
    .map((b) => (b.type === "text" ? (b.text as string) : ""))
    .join("");
}

/**
 * OpenAI 요청 본문 → Messages 요청 본문.
 * `names` 는 원래 툴 이름 → 보낼 이름(Claude 는 점이 든 이름을 못 받는다).
 */
export function toMessagesRequest(body: Json, model: string, names: Map<string, string> = new Map()): Json {
  const rename = (n: string) => names.get(n) ?? n;
  const system: string[] = [];
  const messages: { role: "user" | "assistant"; content: Block[] }[] = [];
  // 같은 역할이 이어지면 한 메시지로 합친다. 툴 결과와 그 뒤에 붙는 사용자 말(끼어든 말·그림
  // 검토)이 한 user 메시지가 되고, tool_result 블록이 앞에 온다.
  const push = (role: "user" | "assistant", content: Block[]) => {
    if (content.length === 0) return;
    const last = messages[messages.length - 1];
    if (last?.role === role) last.content.push(...content);
    else messages.push({ role, content: [...content] });
  };

  for (const m of (Array.isArray(body.messages) ? body.messages : []) as Json[]) {
    switch (m?.role) {
      case "system":
        system.push(textOf(m.content));
        break;
      case "user":
        push("user", contentBlocks(m.content));
        break;
      case "assistant": {
        // 이번 요청 안에서 Claude 가 돌려준 블록은 한 글자도 안 바꾸고 다시 보낸다 — 생각 블록의
        // signature 가 앞쪽 기록과 묶여 있어서, 빼거나 고치면 그 턴의 추론을 잃는다.
        if (Array.isArray(m.anthropic_content)) {
          push("assistant", m.anthropic_content as Block[]);
          break;
        }
        const calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []) as WireCall[];
        push("assistant", [
          ...contentBlocks(m.content),
          ...calls.map((c) => ({
            type: "tool_use",
            id: c.id,
            name: rename(c.function?.name ?? ""),
            input: parseArgs(c.function?.arguments),
          })),
        ]);
        break;
      }
      case "tool":
        // 이미지가 든 결과(web.scrape 의 페이지 이미지)는 블록 그대로 — tool_result 는 글과 이미지를 받는다.
        push("user", [{
          type: "tool_result",
          tool_use_id: m.tool_call_id,
          content: Array.isArray(m.content) ? contentBlocks(m.content) : textOf(m.content),
        }]);
        break;
    }
  }

  const out: Json = {
    model,
    max_tokens: Math.max(typeof body.max_tokens === "number" ? body.max_tokens : 0, CLAUDE_MIN_MAX_TOKENS),
    stream: true,
    messages,
    // 생각은 Claude 5 에서 늘 켜져 있다. 요약을 받아 화면의 "생각" 칸에 보인다(요금은 같다).
    // 앞쪽이 바뀌어 생각 블록이 안 맞으면 400 대신 그 블록만 버리게 명시한다(Rust 가 beta 헤더를 단다).
    thinking: { type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } },
    // 대화가 자랄수록 끝에 캐시 지점을 옮겨 단다. 시스템·툴 앞부분은 아래 표시로 따로 고정한다.
    cache_control: { type: "ephemeral" },
  };
  const sys = system.filter(Boolean).join("\n");
  if (sys) out.system = [{ type: "text", text: sys, cache_control: { type: "ephemeral" } }];

  const tools = (Array.isArray(body.tools) ? body.tools : []) as { function?: Json }[];
  if (tools.length) {
    out.tools = tools.map(({ function: f = {} }) => ({
      name: rename(String(f.name ?? "")),
      description: f.description ?? "",
      input_schema: f.parameters ?? { type: "object", properties: {} },
    }));
    out.tool_choice = { type: "auto" };
  }
  return out;
}

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  max_tokens: "length",
  refusal: "stop",
};

/** Messages 응답이 끝났을 때의 사용량. 입력은 캐시 안 된 것·캐시 쓰기·캐시 읽기로 나뉜다. */
export interface MessagesUsage {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

/**
 * Messages SSE → OpenAI SSE(`data: {...}` 줄). 조각이 이벤트 중간에서 끊겨 와도 되게
 * 줄이 다 찰 때까지 붙든다. 비스트리밍 호출을 위해 끝난 응답을 OpenAI JSON 한 덩이로도 만든다.
 * `back` 은 보낸 이름 → 원래 툴 이름.
 */
export function createMessagesStreamAdapter(back: Map<string, string> = new Map()) {
  let buf = "";
  const usage: MessagesUsage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
  /** Messages 블록 index → OpenAI tool_calls index. */
  const toolIndex = new Map<number, number>();
  const blocks: Block[] = [];
  const toolJson = new Map<number, string>();
  let finish: string | null = null;
  let stopReason: string | null = null;
  let error: string | null = null;
  /** 서버가 요청을 고쳐 받은 내역. 생각 블록이 버려졌으면 여기 나온다(앞쪽이 바뀌었다는 뜻). */
  let transformations: unknown[] = [];

  const line = (delta: Json, finishReason: string | null = null) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`;

  const handle = (ev: Json): string => {
    switch (ev.type) {
      case "message_start": {
        const u = ((ev.message as Json)?.usage ?? {}) as Json;
        usage.input = Number(u.input_tokens ?? 0);
        usage.cacheWrite = Number(u.cache_creation_input_tokens ?? 0);
        usage.cacheRead = Number(u.cache_read_input_tokens ?? 0);
        const t = (ev.message as Json)?.input_transformations;
        if (Array.isArray(t)) transformations = t;
        return "";
      }
      case "content_block_start": {
        const i = Number(ev.index);
        const b = { ...((ev.content_block ?? {}) as Block) };
        blocks[i] = b;
        if (b.type !== "tool_use") return "";
        const n = toolIndex.size;
        toolIndex.set(i, n);
        toolJson.set(i, "");
        const name = String(b.name ?? "");
        return line({
          tool_calls: [{ index: n, id: b.id, type: "function", function: { name: back.get(name) ?? name, arguments: "" } }],
        });
      }
      case "content_block_delta": {
        const i = Number(ev.index);
        const d = (ev.delta ?? {}) as Json;
        const b = blocks[i] ?? (blocks[i] = {});
        switch (d.type) {
          case "text_delta":
            b.text = String(b.text ?? "") + d.text;
            return line({ content: d.text });
          case "thinking_delta":
            b.thinking = String(b.thinking ?? "") + d.thinking;
            return line({ reasoning_content: d.thinking });
          case "signature_delta":
            b.signature = String(b.signature ?? "") + d.signature;
            return "";
          case "input_json_delta":
            toolJson.set(i, (toolJson.get(i) ?? "") + d.partial_json);
            return line({ tool_calls: [{ index: toolIndex.get(i) ?? 0, function: { arguments: d.partial_json } }] });
        }
        return "";
      }
      case "content_block_stop": {
        const i = Number(ev.index);
        if (toolJson.has(i)) blocks[i].input = parseArgs(toolJson.get(i));
        return "";
      }
      case "message_delta": {
        stopReason = String(((ev.delta as Json) ?? {}).stop_reason ?? "") || null;
        usage.output = Number(((ev.usage as Json) ?? {}).output_tokens ?? usage.output);
        finish = FINISH[stopReason ?? ""] ?? "stop";
        // 거절은 본문이 비어 끝난다. 그대로 두면 "응답을 해석하지 못했어" 가 된다.
        const refusal = stopReason === "refusal" ? line({ content: "Claude 가 이 요청은 답하지 않겠다고 했어." }) : "";
        return refusal + line({}, finish);
      }
      case "message_stop":
        return (
          `data: ${JSON.stringify({ choices: [], usage: openAiUsage(), anthropic_content: blocks.filter(Boolean) })}\n\n` +
          "data: [DONE]\n\n"
        );
      case "error":
        error = String(((ev.error as Json) ?? {}).message ?? "Claude 스트림 오류");
        return "";
    }
    return "";
  };

  const openAiUsage = () => ({
    prompt_tokens: usage.input + usage.cacheWrite + usage.cacheRead,
    completion_tokens: usage.output,
    total_tokens: usage.input + usage.cacheWrite + usage.cacheRead + usage.output,
  });

  const drain = (flush: boolean): string => {
    const lines = buf.split("\n");
    buf = flush ? "" : lines.pop() ?? "";
    let out = "";
    for (const l of lines) {
      const t = l.trim();
      if (!t.startsWith("data:")) continue;
      try {
        out += handle(JSON.parse(t.slice(5)) as Json);
      } catch {
        // 깨진 줄은 건너뛴다.
      }
    }
    return out;
  };

  return {
    /** 받은 조각 → 지금 내보낼 OpenAI SSE. */
    push(text: string): string {
      buf += text;
      return drain(false);
    },
    end(): string {
      return drain(true);
    },
    /** 스트림 안에서 온 오류(과부하 등). 없으면 null. */
    get error(): string | null {
      return error;
    },
    get usage(): MessagesUsage {
      return usage;
    },
    get stopReason(): string | null {
      return stopReason;
    },
    get transformations(): unknown[] {
      return transformations;
    },
    /** 받은 블록 원본(생각 블록의 signature 포함). 다음 턴에 그대로 돌려보낼 때 쓴다. */
    get blocks(): Block[] {
      return blocks.filter(Boolean);
    },
    /** 비스트리밍 호출용: 끝난 응답을 OpenAI JSON 한 덩이로. */
    completion(): Json {
      const text = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("");
      const reasoning = blocks.filter((b) => b?.type === "thinking").map((b) => b.thinking ?? "").join("");
      const calls = blocks
        .filter((b) => b?.type === "tool_use")
        .map((b) => {
          const name = String(b.name ?? "");
          return { id: b.id, type: "function", function: { name: back.get(name) ?? name, arguments: JSON.stringify(b.input ?? {}) } };
        });
      return {
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: stopReason === "refusal" && !text ? "Claude 가 이 요청은 답하지 않겠다고 했어." : text,
              ...(reasoning ? { reasoning_content: reasoning } : {}),
              ...(calls.length ? { tool_calls: calls } : {}),
            },
            finish_reason: finish ?? "stop",
          },
        ],
        usage: openAiUsage(),
        anthropic_content: blocks.filter(Boolean),
      };
    },
  };
}

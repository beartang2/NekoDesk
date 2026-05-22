import type { LlmMessage, LlmParams, LlmStreamChunk, ParsedAgentStep } from "./types";
import { getMcpTools } from "./mcp-registry";

// llama.cpp default endpoint — configurable via localStorage
const DEFAULT_LLM_URL = "http://127.0.0.1:8803";

function getLlmUrl(): string {
  return localStorage.getItem("nekodesk_llm_url") ?? DEFAULT_LLM_URL;
}

// ── Agent system prompt (built dynamically with MCP tools) ────────────────────

const STATIC_TOOLS_DESC = `- todo.list: 열린 할 일 목록을 가져온다 (params: {})
- todo.add: 할 일을 추가한다 (params: { "content": string, "due_at": string | null })
- todo.complete: 할 일을 완료 처리한다 (params: { "id": number })
- schedule.list: 일정을 조회한다 (params: { "range": "today" | "week" | "all" })
- schedule.add: 일정을 추가한다 (params: { "title": string, "start_at": string, "end_at": string | null })
- code.exec: Python, Shell, AppleScript를 로컬에서 실행하고 결과를 반환한다 (params: { "code": string, "language": "python" | "shell" | "applescript", "work_dir": string | null })
- web.search: 웹에서 정보를 검색한다 (params: { "query": string })
- web.scrape: 특정 URL의 페이지 내용을 가져온다 (params: { "url": string })
- file.upload: 첨부된 파일을 HTTP 엔드포인트에 multipart/form-data로 업로드한다 (params: { "url": string, "field_name": string, "filename": string })
- weather.get: 현재 날씨와 단기 예보를 가져온다 (params: { "location": string })
- news.search: 뉴스를 검색한다. 결과는 영어지만 한국어로 번역해서 답한다 (params: { "query": string })`;

function nowKst(): string {
  return new Date().toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  });
}

function buildAgentSystemPrompt(): string {
  const mcpEntries = getMcpTools();
  const mcpDesc = mcpEntries.length > 0
    ? "\n" + mcpEntries.map((e) => {
        const props = e.tool.inputSchema?.properties ?? {};
        const paramStr = Object.entries(props)
          .map(([k, v]) => `"${k}": ${(v as { type: string }).type}`)
          .join(", ");
        return `- ${e.tool.name}: ${e.tool.description} [MCP:${e.serverName}] (params: { ${paramStr} })`;
      }).join("\n")
    : "";

  const profile = localStorage.getItem("nekodesk_user_profile")?.trim();
  const profileSection = profile ? `\n\n사용자 프로필:\n${profile}` : "";

  return `너는 NekoDesk 고양이 어시스턴트야. 사용자를 돕기 위해 툴을 순서대로 사용해.
현재 날짜/시각: ${nowKst()}${profileSection}

사용 가능한 툴:
${STATIC_TOOLS_DESC}${mcpDesc}

규칙:
1. 매번 아래 JSON만 출력해. 다른 텍스트는 절대 쓰지 마.
2. 사용자의 요청이 완전히 완료됐을 때만 tool을 "none"으로 설정해. 중간에 정보를 얻었더라도 아직 할 작업이 남아있으면 반드시 다음 툴을 계속 호출해야 해.
3. thought는 한 문장 이내로 짧게.
4. "도구 목록", "기능", "뭐 할 수 있어" 같은 자기 자신에 관한 질문은 툴을 쓰지 말고 위 목록을 참고해서 finalAnswer로 바로 답해.
5. finalAnswer에서 목록이나 비교는 마크다운 표(| col | col |)를 사용해.
6. 여러 단계가 필요한 작업(예: 파일 업로드 후 프로세스 실행)은 모든 단계를 직접 순서대로 실행해. 방법을 설명하고 멈추지 마.
7. 툴 결과에 "error" 필드가 있거나 status가 실패("terminated", "failed", "error" 등)를 나타내면 즉시 루프를 중단하고 tool을 "none"으로 설정한 뒤 finalAnswer로 오류 내용을 사용자에게 보고해.
8. 단순 인사, 잡담, 감사 인사 등 툴이 전혀 필요없는 대화는 즉시 tool을 "none"으로 설정하고 finalAnswer로 바로 답해.
9. web.scrape는 반드시 web.search로 결과를 먼저 받은 뒤에만 사용해. 검색 없이 단독으로 호출하지 마.
10. 웹 검색 시 영어 쿼리를 우선으로 사용해. 영어로 검색해도 충분한 결과가 없을 것 같은 경우에만 한국어로 검색해.
11. 사용자가 명시적으로 요청하지 않아도 기억해둘 만한 것(나중에 할 일, 아이디어, 메모, 확인해야 할 것 등)이 대화에 등장하면 스스로 판단해서 todo.add를 호출해. 단, 이미 완료된 일이나 단순 사실 언급은 추가하지 마.
12. 모든 툴은 명시적 지시 없이도 자유롭게 활용해. 정보 검색이 필요하다 싶으면 web.search, 계산이나 자동화가 필요하면 code.exec, 일정이 언급되면 schedule.add 등 상황에 맞는 툴을 스스로 선택해서 실행해.

출력 형식:
{"thought":"...","tool":"툴이름 또는 none","params":{},"finalAnswer":"tool이 none일 때만"}`;
}

// ── Chat system prompt ────────────────────────────────────────────────────────

export const DEFAULT_CHAT_SYSTEM_PROMPT = `너는 NekoDesk 어시스턴트야. 친근하고 간결하게 말해.
- 한국어로 답변해. 사용자가 다른 언어로 말하면 그 언어로 답해.
- 목록이나 비교가 필요한 경우 마크다운 표(| col | col |)를 사용해.
- 응답 마지막에 반드시 [[PET_STATE:감정]] 형식으로 고양이 감정을 표시해. (idle/happy/curious/proud/sleepy/error 중 하나)
- 실제로 실행된 작업만 완료됐다고 해.`;

const STATIC_TOOLS_BRIEF = `todo.list, todo.add, todo.complete, schedule.list, schedule.add, code.exec, web.search, web.scrape, weather.get, news.search`;

/** Returns base system prompt + dynamic tool list injected at the end. */
function buildChatSystemPrompt(): string {
  const base = localStorage.getItem("nekodesk_system_prompt") ?? DEFAULT_CHAT_SYSTEM_PROMPT;
  const dateSection = `\n현재 날짜/시각: ${nowKst()}`;

  const mcpEntries = getMcpTools();
  const mcpList = mcpEntries.length > 0
    ? "\n" + mcpEntries.map((e) => `- ${e.tool.name} [MCP:${e.serverName}]: ${e.tool.description}`).join("\n")
    : "";

  const toolsSection = `\n\n사용 가능한 도구 (사용자가 물어보면 목록을 알려줘):\n- 기본: ${STATIC_TOOLS_BRIEF}${mcpList}`;

  const profile = localStorage.getItem("nekodesk_user_profile")?.trim();
  const profileSection = profile ? `\n사용자 프로필:\n${profile}` : "";

  return base + dateSection + profileSection + toolsSection;
}

// ── Core fetch ────────────────────────────────────────────────────────────────

export async function fetchCompletion(
  messages: LlmMessage[],
  params: LlmParams = {}
): Promise<string> {
  const res = await fetch(`${getLlmUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      temperature: params.temperature ?? 0.1,
      max_tokens: params.max_tokens ?? 256,
      stream: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
  };
  return data.choices[0]?.message?.content ?? "";
}

export async function* fetchStream(
  messages: LlmMessage[],
  params: LlmParams = {}
): AsyncGenerator<LlmStreamChunk> {
  const res = await fetch(`${getLlmUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 512,
      stream: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`LLM stream error ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";
  // Think-tag filter state: suppress tokens inside <think>...</think>
  let thinkBuf = "";
  let inThink = false;

  // Returns the token with any <think>...</think> content removed.
  // Stateful across chunks so partial tags spanning chunks are handled.
  function filterThink(token: string): string {
    let out = "";
    thinkBuf += token;
    while (thinkBuf.length > 0) {
      if (inThink) {
        const end = thinkBuf.indexOf("</think>");
        if (end === -1) {
          // Still inside think block, consume all and wait
          thinkBuf = "";
          break;
        }
        // Consume through </think>
        thinkBuf = thinkBuf.slice(end + "</think>".length);
        inThink = false;
      } else {
        const start = thinkBuf.indexOf("<think>");
        if (start === -1) {
          out += thinkBuf;
          thinkBuf = "";
          break;
        }
        out += thinkBuf.slice(0, start);
        thinkBuf = thinkBuf.slice(start + "<think>".length);
        inThink = true;
      }
    }
    return out;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") {
        yield { content: "", done: true };
        return;
      }
      try {
        const chunk = JSON.parse(payload) as {
          choices: Array<{ delta: { content?: string }; finish_reason: string | null }>;
        };
        const raw = chunk.choices[0]?.delta?.content ?? "";
        const finished = chunk.choices[0]?.finish_reason != null;
        const content = filterThink(raw);
        if (content) yield { content, done: finished };
        else if (finished) yield { content: "", done: true };
        if (finished) return;
      } catch {
        // malformed chunk — skip
      }
    }
  }

  yield { content: "", done: true };
}

// ── Agent step call ───────────────────────────────────────────────────────────

function extractJson(raw: string): string {
  // Strip <think>...</think> blocks
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  // Try to find a JSON object in the output
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) return match[0];
  return stripped;
}

function parseAgentResponse(raw: string): ParsedAgentStep {
  const json = extractJson(raw);

  try {
    const parsed = JSON.parse(json) as Partial<ParsedAgentStep>;
    return {
      thought: typeof parsed.thought === "string" ? parsed.thought : "",
      tool: isValidTool(parsed.tool) ? parsed.tool : "none",
      params: typeof parsed.params === "object" && parsed.params !== null
        ? parsed.params as Record<string, unknown>
        : {},
      finalAnswer: typeof parsed.finalAnswer === "string" ? parsed.finalAnswer : undefined,
    };
  } catch {
    // JSON parse failed — strip think tags and JSON wrapper, use as plain answer
    const stripped = raw
      .replace(/<think>[\s\S]*?<\/think>/g, "")
      .replace(/^\s*\{[\s\S]*"finalAnswer"\s*:\s*"([\s\S]*)"\s*\}\s*$/, "$1")
      .trim();
    return {
      thought: "응답 파싱 실패",
      tool: "none",
      params: {},
      finalAnswer: stripped || "처리 중 문제가 발생했어.",
    };
  }
}

const STATIC_TOOL_NAMES = new Set([
  "todo.list", "todo.add", "todo.complete",
  "schedule.list", "schedule.add", "code.exec", "web.search", "web.scrape",
  "file.upload", "weather.get", "news.search", "none",
]);

function isValidTool(val: unknown): val is string {
  if (typeof val !== "string") return false;
  if (STATIC_TOOL_NAMES.has(val)) return true;
  // Also accept any loaded MCP tool
  return getMcpTools().some((e) => e.tool.name === val);
}

export async function agentStep(messages: LlmMessage[]): Promise<ParsedAgentStep> {
  const systemMessage: LlmMessage = { role: "system", content: buildAgentSystemPrompt() };
  const allMessages = [systemMessage, ...messages];

  const raw = await fetchCompletion(allMessages, { temperature: 0.1, max_tokens: 1024 });
  return parseAgentResponse(raw);
}

// ── Chat response (streaming) ─────────────────────────────────────────────────

export function chatStream(
  messages: LlmMessage[],
  toolContext: string
): AsyncGenerator<LlmStreamChunk> {
  const systemMessage: LlmMessage = { role: "system", content: buildChatSystemPrompt() };
  const contextMessage: LlmMessage | null = toolContext
    ? { role: "user", content: `[수집된 정보]\n${toolContext}` }
    : null;

  const allMessages: LlmMessage[] = [
    systemMessage,
    ...(contextMessage ? [contextMessage] : []),
    ...messages,
  ];

  return fetchStream(allMessages, { temperature: 0.7, max_tokens: 512 });
}

// ── Context compaction ────────────────────────────────────────────────────────

/** Claude Code 방식의 컨텍스트 compact: 대화를 요약해서 반환한다. */
export async function compactMessages(messages: LlmMessage[]): Promise<string> {
  const conversationText = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const role = m.role === "user" ? "사용자" : "어시스턴트";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}]\n${content}`;
    })
    .join("\n\n");

  const systemMsg: LlmMessage = {
    role: "system",
    content: "다음 대화를 간결하게 요약해줘. 핵심 사실, 완료된 작업, 중요한 결정, 진행 중인 사항을 포함해. 한국어로 작성해.",
  };
  const userMsg: LlmMessage = {
    role: "user",
    content: `대화 내용:\n\n${conversationText}\n\n위 대화를 간결하게 요약해줘.`,
  };

  return fetchCompletion([systemMsg, userMsg], { temperature: 0.3, max_tokens: 1024 });
}

// ── Health check ──────────────────────────────────────────────────────────────

export async function checkLlmHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${getLlmUrl()}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

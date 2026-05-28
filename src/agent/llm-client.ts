import type { LlmMessage, LlmParams, LlmStreamChunk, ParsedAgentStep } from "./types";
import { getMcpTools } from "./mcp-registry";
import { buildKnowledgeSection } from "./knowledge";

// llama.cpp default endpoint — configurable via localStorage
const DEFAULT_LLM_URL = "http://127.0.0.1:8803";

function getLlmUrl(): string {
  return localStorage.getItem("nekodesk_llm_url") ?? DEFAULT_LLM_URL;
}

// ── Generation parameters ─────────────────────────────────────────────────────

export const GEN_PARAMS_KEY = "nekodesk_gen_params";

export const DEFAULT_GEN_PARAMS = {
  max_tokens_agent: 1024,
  max_tokens_chat: 512,
};

export type GenParams = typeof DEFAULT_GEN_PARAMS;

export function loadGenParams(): GenParams {
  try {
    const raw = localStorage.getItem(GEN_PARAMS_KEY);
    return raw ? { ...DEFAULT_GEN_PARAMS, ...JSON.parse(raw) } : { ...DEFAULT_GEN_PARAMS };
  } catch {
    return { ...DEFAULT_GEN_PARAMS };
  }
}

export function saveGenParams(p: GenParams) {
  localStorage.setItem(GEN_PARAMS_KEY, JSON.stringify(p));
}

// ── Agent system prompt (built dynamically with MCP tools) ────────────────────

const STATIC_TOOLS_DESC = `- todo.list: 열린 할 일 목록을 가져온다 (params: {})
- todo.add: 할 일을 추가한다 (params: { "content": string, "due_at": string | null })
- todo.complete: 할 일을 완료 처리한다 (params: { "id": number })
- schedule.list: 일정을 조회한다 (params: { "range": "today" | "week" | "all" })
- schedule.add: 일정을 추가한다 (params: { "title": string, "start_at": string, "end_at": string | null }) ※ start_at/end_at은 반드시 ISO 8601 형식(예: "2026-05-22" 또는 "2026-05-22T14:00:00")으로 작성
- schedule.delete: 일정을 삭제한다 (params: { "id": number }) ※ 삭제 전 반드시 schedule.list로 id를 조회해서 사용
- code.exec: Python, Shell, AppleScript를 로컬에서 실행하고 결과를 반환한다 (params: { "code": string, "language": "python" | "shell" | "applescript", "work_dir": string | null }) ※ language가 "applescript"일 때 code는 순수 AppleScript 문법만 작성 (osascript -e 래퍼 절대 사용 금지. 예: tell application "Music" to get name of current track)
- web.search: 웹에서 정보를 검색한다 (params: { "query": string })
- web.scrape: 특정 URL의 페이지 내용을 가져온다 (params: { "url": string })
- file.upload: 첨부된 파일을 HTTP 엔드포인트에 multipart/form-data로 업로드한다. url은 반드시 사용자가 직접 알려준 실제 URL만 사용해. 절대 URL을 추측하거나 만들어내지 마. (params: { "url": string, "field_name": string, "filename": string })
- weather.get: 현재 날씨와 단기 예보를 가져온다 (params: { "location": string })
- user.ask: 작업을 시작하기 전에 사용자에게 선택지로 질문한다. 잘못 진행하면 되돌리기 어렵거나 중요한 분기가 필요할 때만 사용해. 명확한 요청엔 절대 사용하지 마. (params: { "question": string, "options": string[] })`;

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

function buildAgentSystemPrompt(userInput = ""): string {
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
현재 날짜/시각: ${nowKst()}${profileSection}${buildKnowledgeSection(userInput)}

사용 가능한 툴:
${STATIC_TOOLS_DESC}${mcpDesc}

규칙:
1. 매번 아래 JSON만 출력해. 다른 텍스트는 절대 쓰지 마.
2. 사용자의 요청이 완전히 완료됐을 때만 tool을 "none"으로 설정해. 중간에 정보를 얻었더라도 아직 할 작업이 남아있으면 반드시 다음 툴을 계속 호출해야 해.
3. thought는 한 문장 이내로 짧게.
4. "도구 목록", "기능", "뭐 할 수 있어" 같은 자기 자신에 관한 질문은 툴을 쓰지 말고 위 목록을 참고해서 finalAnswer로 바로 답해.
5. finalAnswer에서 목록이나 비교는 마크다운 표(| col | col |)를 사용해.
6. 여러 단계가 필요한 작업(예: 파일 업로드 후 프로세스 실행)은 모든 단계를 직접 순서대로 실행해. 방법을 설명하고 멈추지 마.
7. 툴 결과에 오류가 감지되면(exit_code != 0, stderr에 에러, "error" 필드 등):
   a. 오류 메시지에서 개인정보(파일 경로, 사용자명, API키, 호스트명 등)를 제거한다.
   b. 오류 핵심("command not found: ffmpeg", "permission denied" 등)만으로 web.search를 먼저 실행해 해결책을 찾는다.
   c. 검색 결과를 반영해 수정된 방법으로 재시도한다.
   d. 같은 오류가 두 번 반복되면 즉시 tool을 "none"으로 설정하고 finalAnswer로 오류를 보고한다.
15. code.exec에서 사용자의 한국어 키워드(검색어·아티스트명·앱 이름·플레이리스트명 등)는 영어/로마자로 변환해서 먼저 실행해. 실패하면 원문 한국어로 재시도해. (예: "요루시카" → 먼저 "Yorushika"로 검색, 실패 시 "요루시카"로 재시도)
8. 단순 인사, 잡담, 감사 인사 등 툴이 전혀 필요없는 대화는 즉시 tool을 "none"으로 설정하고 finalAnswer로 바로 답해.
18. 사용자가 이미지를 첨부하면 너는 그 이미지를 직접 볼 수 있어. file.upload나 web.search 없이 즉시 tool을 "none"으로 설정하고 보이는 내용을 finalAnswer로 답해.
9. web.scrape는 반드시 web.search로 결과를 먼저 받은 뒤에만 사용해. 검색 없이 단독으로 호출하지 마.
10. 웹 검색 시 영어 쿼리를 우선으로 사용해. 영어로 검색해도 충분한 결과가 없을 것 같은 경우에만 한국어로 검색해.
11. 사용자가 명시적으로 요청하지 않아도 기억해둘 만한 것(나중에 할 일, 아이디어, 메모, 확인해야 할 것 등)이 대화에 등장하면 스스로 판단해서 todo.add를 호출해. 단, 이미 완료된 일이나 단순 사실 언급은 추가하지 마.
12. 모든 툴은 명시적 지시 없이도 자유롭게 활용해. 계산이나 자동화가 필요하면 code.exec, 일정이 언급되면 schedule.add 등 상황에 맞는 툴을 스스로 선택해서 실행해. 단, web.search는 사용자가 검색을 명시적으로 요청했거나, 실시간·최신 정보(뉴스, 날씨 제외, 가격, 공식 발표 등)가 꼭 필요할 때만 사용해. 일반 지식, 의견, 생각을 묻는 질문에는 검색하지 말고 바로 답해.
13. user.ask는 요청이 모호해서 잘못된 방향으로 진행되면 되돌리기 어려운 경우에만 사용해. 파일 삭제·덮어쓰기·어느 대상에 적용할지 불명확한 경우 등. 단순 질문이나 명확한 요청엔 절대 쓰지 마. options는 2~4개로 제한해.
16. Messages 앱·이메일·SNS 등 외부로 메시지를 전송하기 직전에는 반드시 user.ask로 수신자명과 메시지 내용을 확인받아. 예: question="알투 윤원님 (01025750827)께 이 메시지를 보낼까요?\n\n메롱", options=["보내기", "취소"]
17. Messages 앱(iMessage/SMS)으로 전송할 때, code.exec의 AppleScript 코드 안에서 send 명령에 전달하는 메시지 문자열 끝에 "\n\nsent by Neko 🐱"를 붙여. finalAnswer나 네 답변에 붙이는 게 아니라, AppleScript 코드 내 문자열에만 적용해. 예: send "안녕하세요\n\nsent by Neko 🐱" to buddy ...
14. weather.get은 사용자가 날씨를 명시적으로 물어볼 때만 사용해. 사용자가 시간과 목적(일정·약속·활동 등)을 언급하면 반드시 schedule.add를 먼저 실행해. 날씨는 사용자가 따로 요청하지 않는 한 자동으로 조회하지 마.

출력 형식:
{"thought":"...","tool":"툴이름 또는 none","params":{},"finalAnswer":"tool이 none일 때만"}`;
}

// ── Chat system prompt ────────────────────────────────────────────────────────

export const DEFAULT_CHAT_SYSTEM_PROMPT = `너는 NekoDesk 어시스턴트야. 친근하고 간결하게 말해.
- 한국어로 답변해. 사용자가 다른 언어로 말하면 그 언어로 답해.
- 목록이나 비교가 필요한 경우 마크다운 표(| col | col |)를 사용해.
- 응답 마지막에 반드시 [[PET_STATE:감정]] 형식으로 고양이 감정을 표시해. (idle/happy/curious/proud/sleepy/error 중 하나)
- 실제로 실행된 작업만 완료됐다고 해.`;

const STATIC_TOOLS_BRIEF = `todo.list, todo.add, todo.complete, schedule.list, schedule.add, code.exec, web.search, web.scrape, weather.get`;

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
  const p = loadGenParams();
  const body: Record<string, unknown> = {
    messages,
    max_tokens: params.max_tokens ?? p.max_tokens_agent,
    stream: false,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  const res = await fetch(`${getLlmUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string }; finish_reason?: string }>;
  };
  console.log("[fetchCompletion] full response:", JSON.stringify(data));
  return data.choices[0]?.message?.content ?? "";
}

export async function* fetchStream(
  messages: LlmMessage[],
  params: LlmParams = {}
): AsyncGenerator<LlmStreamChunk> {
  const p = loadGenParams();
  const body: Record<string, unknown> = {
    messages,
    max_tokens: params.max_tokens ?? p.max_tokens_chat,
    stream: true,
  };
  if (params.temperature !== undefined) body.temperature = params.temperature;
  const res = await fetch(`${getLlmUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
      thought: typeof parsed.thought === "string" ? parsed.thought.slice(0, 300) : "",
      tool: isValidTool(parsed.tool) ? parsed.tool : "none",
      params: typeof parsed.params === "object" && parsed.params !== null
        ? parsed.params as Record<string, unknown>
        : {},
      finalAnswer: typeof parsed.finalAnswer === "string" ? parsed.finalAnswer : undefined,
    };
  } catch {
    // JSON parse failed (often due to max_tokens truncation).
    // 1) Try to pull finalAnswer out of the partial JSON via regex.
    // 2) If it still looks like raw JSON, show a friendly error instead.
    console.warn("[agentStep] JSON parse failed. raw:", raw, "| extracted:", json);
    const faMatch = json.match(/"finalAnswer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (faMatch) {
      return {
        thought: "응답 파싱 실패",
        tool: "none",
        params: {},
        finalAnswer: faMatch[1].replace(/\\n/g, "\n").replace(/\\"/g, '"'),
      };
    }

    const stripped = raw.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    const looksLikeJson = stripped.startsWith("{") || stripped.startsWith("[");
    return {
      thought: "응답 파싱 실패",
      tool: "none",
      params: {},
      finalAnswer: looksLikeJson || !stripped ? "처리 중 문제가 발생했어. 다시 시도해줘." : stripped,
    };
  }
}

const STATIC_TOOL_NAMES = new Set([
  "todo.list", "todo.add", "todo.complete",
  "schedule.list", "schedule.add", "schedule.delete", "code.exec", "web.search", "web.scrape",
  "file.upload", "weather.get", "user.ask", "none",
]);

function isValidTool(val: unknown): val is string {
  if (typeof val !== "string") return false;
  if (STATIC_TOOL_NAMES.has(val)) return true;
  // Also accept any loaded MCP tool
  return getMcpTools().some((e) => e.tool.name === val);
}

function stripImageParts(messages: LlmMessage[]): { messages: LlmMessage[]; hadImages: boolean } {
  let hadImages = false;
  const stripped = messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const textOnly = m.content
      .filter((p) => p.type !== "image_url")
      .map((p) => (p.type === "text" ? p.text : ""))
      .join("\n")
      .trim();
    hadImages = true;
    return { ...m, content: textOnly || "(이미지 첨부됨)" };
  });
  return { messages: stripped, hadImages };
}

export async function agentStep(messages: LlmMessage[], userInput = ""): Promise<ParsedAgentStep> {
  const systemMessage: LlmMessage = { role: "system", content: buildAgentSystemPrompt(userInput) };
  const allMessages = [systemMessage, ...messages];

  try {
    const raw = await fetchCompletion(allMessages, { temperature: 0.1, max_tokens: 1024 });
    return parseAgentResponse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 이미지 처리 실패 시 이미지를 빼고 재시도
    if (msg.includes("failed to process image") || msg.includes("500")) {
      const { messages: fallback, hadImages } = stripImageParts(allMessages);
      if (hadImages) {
        const note = fallback[fallback.length - 1];
        if (note && typeof note.content === "string") {
          note.content = `${note.content}\n\n[이미지를 첨부했지만 현재 모델이 이미지를 지원하지 않아요.]`;
        }
        const raw2 = await fetchCompletion(fallback, { temperature: 0.1, max_tokens: 1024 });
        return parseAgentResponse(raw2);
      }
    }
    throw err;
  }
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
export async function compactMessages(messages: LlmMessage[], previousSummary?: string): Promise<string> {
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
    content: "대화 내용을 간결하게 요약해줘. 핵심 사실, 완료된 작업, 중요한 결정, 진행 중인 사항을 포함해. 한국어로 작성해.",
  };

  const prevSection = previousSummary
    ? `[이전 요약]\n${previousSummary}\n\n`
    : "";
  const userMsg: LlmMessage = {
    role: "user",
    content: `${prevSection}[새 대화]\n${conversationText}\n\n위 내용을 하나의 요약으로 합쳐줘.`,
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

// ── Model info ────────────────────────────────────────────────────────────────

export interface LlmModelInfo {
  id: string;
  /** llama.cpp /props 에서 추가 정보 */
  context_length?: number;
  n_params?: number;
}

export async function fetchLoadedModel(): Promise<LlmModelInfo | null> {
  try {
    const res = await fetch(`${getLlmUrl()}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const data = await res.json() as { data?: Array<{ id: string }> };
    const first = data.data?.[0];
    if (!first) return null;
    // Try to get extra info from /props (llama.cpp specific)
    try {
      const propsRes = await fetch(`${getLlmUrl()}/props`, { signal: AbortSignal.timeout(2000) });
      if (propsRes.ok) {
        const props = await propsRes.json() as Record<string, unknown>;
        return {
          id: first.id,
          context_length: typeof props.n_ctx === "number" ? props.n_ctx : undefined,
          n_params: typeof props.total_params === "number" ? props.total_params : undefined,
        };
      }
    } catch { /* props optional */ }
    return { id: first.id };
  } catch {
    return null;
  }
}

// ── Warm-up ───────────────────────────────────────────────────────────────────

/** KV cache 초기화용 빈 요청. 첫 실제 대화 지연 제거. */
export async function warmUpModel(): Promise<boolean> {
  try {
    const res = await fetch(`${getLlmUrl()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(30000),
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
        stream: false,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

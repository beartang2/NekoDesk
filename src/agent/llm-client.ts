import type {
  AgentTurn,
  LlmMessage,
  LlmParams,
  LlmStreamChunk,
  ParsedAgentStep,
  RawToolCallDelta,
  ToolCall,
  WireToolCall,
} from "./types";
import { getMcpTools } from "./mcp-registry";
import { buildToolSchemas, describeToolsForPrompt } from "./tool-schemas";
import { ToolCallAccumulator, fromWireToolCalls } from "./tool-calls";
import { buildKnowledgeSection } from "./knowledge";
import { createJsonStringFieldStreamer } from "./json-stream";
import {
  shouldUseNativeTools,
  useSettingsStore,
  type GenParams,
} from "../stores/settingsStore";

function getLlmUrl(): string {
  return useSettingsStore.getState().llmUrl;
}

/**
 * 에이전트 스텝 출력을 valid JSON 객체로 강제하는 GBNF grammar.
 * 모델이 이스케이프 안 된 따옴표·개행으로 JSON 을 깨뜨리는 것을 뿌리에서 막는다
 * (표를 finalAnswer 에 넣을 때 특히). 문자열 이스케이프까지 문법이 강제한다.
 * (json_schema/response_format 은 이 llama.cpp 빌드의 sampler 에서 400 → grammar 사용)
 */
const AGENT_JSON_GRAMMAR = `root   ::= object
object ::= "{" ws ( string ":" ws value ("," ws string ":" ws value)* )? "}" ws
value  ::= object | array | string | number | ("true"|"false"|"null") ws
array  ::= "[" ws ( value ("," ws value)* )? "]" ws
string ::= "\\"" ( [^"\\\\\\x7F\\x00-\\x1F] | "\\\\" (["\\\\bfnrt/] | "u" [0-9a-fA-F]{4}) )* "\\"" ws
number ::= ("-"? ([0-9] | [1-9][0-9]*)) ("." [0-9]+)? ([eE][-+]?[0-9]+)? ws
ws     ::= [ \\t\\n]*`;

/**
 * 로컬 llama.cpp 는 느릴 수 있으니 넉넉하게 잡되, 무한 대기는 막는다.
 * 서버가 멈추면 고양이가 영원히 'working' 상태로 굳는다.
 */
const LLM_TIMEOUT_MS = 180_000;

/** 호출자의 취소 신호와 타임아웃을 합친다. 둘 중 먼저 오는 쪽이 이긴다. */
function abortAfterTimeout(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(LLM_TIMEOUT_MS);
  if (!signal) return timeout;
  return AbortSignal.any([signal, timeout]);
}

// ── Generation parameters (settingsStore 위임, SettingsModal 백호환 re-export) ────

export type { GenParams };
export const loadGenParams = (): GenParams => useSettingsStore.getState().genParams;
export const saveGenParams = (p: GenParams) => useSettingsStore.getState().setGenParams(p);

// ── Agent system prompt (built dynamically with MCP tools) ────────────────────

/**
 * 행동 규칙.
 *
 * 툴 목록·파라미터·출력 형식은 여기 없다. native 모드에선 서버가 `tools` 스키마로
 * 받고, json 모드에선 `describeToolsForPrompt()` 가 registry 에서 생성한다.
 * 예전에는 이 문자열 안에 툴 설명을 손으로 적어둬서 registry 와 어긋날 수 있었다.
 */
const BEHAVIOR_RULES = `규칙:
1. 사용자의 요청이 완전히 끝났을 때만 툴을 그만 쓰고 답해. 중간에 정보를 얻었더라도 남은 작업이 있으면 계속 툴을 호출해.
2. 여러 단계가 필요한 작업(예: 파일 업로드 후 프로세스 실행)은 모든 단계를 직접 순서대로 실행해. 방법을 설명하고 멈추지 마.
3. 서로 의존하지 않는 조회는 한 번에 여러 툴을 함께 호출해 (예: 할 일 + 오늘 일정).
4. 단순 인사·잡담·감사, "도구 목록"·"뭐 할 수 있어" 같은 자기 자신에 관한 질문은 툴 없이 바로 답해.
5. 사용 가능한 툴로 할 수 없는 작업(UI 테마 변경 등)은 툴을 부르지 말고 "해당 기능은 지원하지 않아"라고 답해.
6. 사용자가 이미지를 첨부하면 너는 그 이미지를 직접 볼 수 있어. 툴 없이 보이는 내용을 바로 답해.
7. 목록·비교는 마크다운 표를 써. (a) 헤더 다음 줄에 구분선 "| --- | --- |"을 꼭 넣고, (b) 모든 행의 칸(|) 개수를 맞추고, (c) 표를 \`\`\` 로 감싸지 마.

툴 사용:
8. 툴은 명시적 지시 없이도 자유롭게 써. 계산·자동화가 필요하면 code.exec, 일정이 언급되면 schedule.add 처럼 상황에 맞게 스스로 골라.
9. web.search 는 사용자가 검색을 명시적으로 요청했거나 실시간·최신 정보(뉴스, 가격, 공식 발표 등)가 꼭 필요할 때만 써. 일반 지식·의견·생각을 묻는 질문엔 검색하지 말고 바로 답해.
10. 웹사이트 주소·URL·홈페이지·"링크 줘"류 질문에는 절대 기억으로 답하지 마. 반드시 web.search 를 먼저 호출해서 실제 검색 결과에 나온 URL만 그대로 복사해 써. 검색해도 확실한 URL이 없으면 링크 대신 이름만 답해.
11. web.scrape 는 web.search 결과를 받은 뒤에만 써. 검색 없이 단독으로 호출하지 마.
12. 검색 쿼리는 영어 우선. 영어로 충분한 결과가 없을 것 같을 때만 한국어로 검색해.
13. weather.get 은 사용자가 날씨를 명시적으로 물어볼 때만. 사용자가 시간과 목적(일정·약속·활동)을 언급하면 schedule.add 를 먼저 실행하고, 날씨는 따로 요청받지 않는 한 자동 조회하지 마.
14. 기억해둘 만한 것(나중에 할 일, 아이디어, 확인해야 할 것)이 대화에 나오면 지시가 없어도 todo.add 를 호출해. 이미 완료된 일이나 단순 사실 언급은 빼.
15. Messages·이메일·SNS 등 외부로 메시지를 보내기 직전에는 반드시 user.ask 로 수신자와 내용을 확인받아.

코드 실행:
16. code.exec 에서 사용자의 한국어 키워드(검색어·아티스트명·앱 이름·플레이리스트명)는 영어/로마자로 바꿔서 먼저 실행하고, 실패하면 원문 한국어로 재시도해. (예: "요루시카" → 먼저 "Yorushika")
17. Python·Shell 로 AppleScript 코드를 생성·조합하지 마. AppleScript 작업은 단일 code.exec(language: "applescript") 호출로 끝내. 날짜 같은 동적 값은 AppleScript 안에서 do shell script 로 처리해 (예: set dateStr to do shell script "date '+%Y-%m-%d'"). 곡명·플레이리스트명은 네가 직접 판단해서 문자열로 써 넣어.
18. Messages 앱으로 보낼 때는 AppleScript 코드 안 send 문자열 끝에 "\\n\\nsent by Neko 🐱"를 붙여. 네 답변이 아니라 코드 속 문자열에만 적용해.
19. Python 으로 이미지를 만들 때는 반드시 "/tmp/neko_output.png" 에 저장해. 그래야 채팅창에 자동으로 표시돼. plt.show() 나 tkinter mainloop() 는 쓰지 마.
20. 툴 결과에 오류가 보이면(exit_code != 0, stderr 에 에러, "error" 필드 등):
    a. 오류에서 개인정보(파일 경로, 사용자명, API키, 호스트명)를 제거한다.
    b. 오류 핵심("command not found: ffmpeg", "permission denied" 등)만으로 web.search 해 해결책을 찾는다.
    c. 찾은 방법으로 고쳐서 재시도한다. 같은 오류가 반복되면 툴을 멈추고 오류를 보고한다.

해석:
21. "너가", "네가", "추천해줘", "골라줘", "어떻게 생각해", "뭐가 좋아" 처럼 네가 주어인 요청은 네가 직접 의견·추천·선택을 내라는 뜻이야. "사용자가 뭔가를 조회하고 싶어 한다"는 뜻이 절대 아니야. 취향·조건이 불명확하면 user.ask 로 먼저 묻고, 정보가 충분하면 툴 없이 바로 답해.
22. 한국어 약어는 아래대로 매핑해. 비슷한 영어 단어로 오해하지 마.
    - 플리 = 플레이리스트 (Music 앱 재생목록, 절대 "Fly" 앱이 아님)
    - 뮤직 = Music 앱 / 캘린더 = Calendar 앱 / 메모 = Notes 앱
    앱 이름이 불명확하면 macOS 기본 앱 맥락에서 먼저 해석해. 새 소프트웨어를 설치하거나 CLI 도구를 실행하는 쪽으로 해석하지 마.`;

/** 말투·정직성. 두 모드 공통 — 최종 답변 전체에 적용된다. */
const STYLE_RULES = `⚠️ 말투 규칙 (답변 전체에 적용, 예외 없음):
① 첫 문장부터 마지막 문장까지 반말(해체)로 통일해. 한 답변 안에서 존댓말과 반말을 섞지 마.
② 금지 어미: ~습니다, ~합니다, ~됩니다, ~입니다, ~해요, ~예요, ~드릴게요, ~드릴게, ~드려요, ~세요, ~십시오.
   대신 이렇게 써: ~야, ~어, ~해, ~거야, ~했어, ~없었어, ~줄게, ~볼게, ~정리했어.
③ 자기 지칭은 "나" 또는 "내가". "네코야는", "고양이는" 같은 3인칭으로 자기를 부르지 마.
④ 툴 결과·웹 검색 문서·인용문의 문체를 그대로 옮기지 마. 내용만 가져오고 문장은 네 말투로 다시 써.
⑤ "네," "네!" 나 사용자 호칭("○○야!")으로 시작하지 마. 바로 본론부터 시작해.
⚠️ 할루시네이션 금지:
① 데이터 날조 금지 — 곡명·아티스트명·URL·검색 결과 등은 절대 만들어내지 마. 답변의 모든 데이터는 반드시 툴 실행 결과에서만 가져와.
② 액션 날조 금지 — 앱 실행·음악 재생·파일 조작·메시지 전송 등 시스템 조작은 반드시 툴을 실제로 호출한 후에만 완료 표현("재생 중이야", "실행했어")을 써. 툴을 호출하지 않았으면 아무것도 실행된 게 아니다.`;

/**
 * json 폴백 모드 전용. native 모드에선 서버가 `tool_calls` 를 직접 파싱하므로
 * 출력 형식·이스케이프 규칙이 통째로 필요 없다.
 *
 * 참고: 손으로 쓴 시스템 프롬프트는 native 가 782토큰 짧지만, 채팅 템플릿이 툴
 * 스키마를 JSON 원문으로 펼치고 호출 형식 설명까지 붙여 1553토큰을 더한다.
 * 즉 **최종 프롬프트는 native 가 767토큰 더 크다** (측정: prompt-size.integration.test.ts).
 * 시스템 프롬프트가 고정이라 이 비용은 프롬프트 캐시에 한 번만 실린다 — native 를
 * 쓰는 이유는 토큰이 아니라 정확성(병렬 호출, 파싱 실패 없음)이다.
 */
const JSON_MODE_RULES = `출력 규칙 (json 모드):
J1. 매번 아래 JSON 만 출력해. 다른 텍스트는 절대 쓰지 마.
J2. 한 번에 툴 하나만 호출할 수 있어. 작업이 끝나면 tool 을 "none" 으로 두고 finalAnswer 에 답을 써.
J3. thought 는 한 문장 이내로 짧게.

{"thought":"...","tool":"툴이름 또는 none","params":{},"finalAnswer":"tool이 none일 때만"}

⚠️ params.code 안에 큰따옴표(")가 있으면 반드시 백슬래시로 이스케이프(\\")해야 해. AppleScript 는 문자열에 큰따옴표를 쓰므로 특히 주의: \\"Music\\", \\"Neko Queue\\" 처럼.`;

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

/**
 * 시각·지식은 이 프롬프트에 넣지 않는다. 매번 바뀌어 llama.cpp 프롬프트 캐시가
 * 깨지면 규칙 전체를 매 쿼리 재처리(수 초 TTFT)한다. 이 부분을 고정해 캐시하고,
 * 시각·지식은 현재 user 메시지에 붙인다(buildAgentContextPrefix).
 */
function buildAgentSystemPrompt(native: boolean): string {
  const profile = useSettingsStore.getState().userProfile?.trim();
  const profileSection = profile ? `\n\n사용자 프로필:\n${profile}` : "";

  const customPrompt = useSettingsStore.getState().systemPrompt?.trim();
  const customSection =
    customPrompt && customPrompt !== DEFAULT_CHAT_SYSTEM_PROMPT.trim()
      ? `\n\n사용자 지정 컨텍스트:\n${customPrompt}`
      : "";

  // native 모드에선 툴 목록을 `tools` 파라미터로 보내므로 프롬프트에 중복 기재하지
  // 않는다. json 모드에서만 registry 에서 생성한 설명을 붙인다.
  const toolsSection = native ? "" : `\n\n사용 가능한 툴:\n${describeToolsForPrompt()}`;
  const modeSection = native ? "" : `\n\n${JSON_MODE_RULES}`;

  return `너는 NekoDesk 고양이 어시스턴트야. 사용자를 돕기 위해 툴을 사용해.${profileSection}${customSection}${toolsSection}

${BEHAVIOR_RULES}${modeSection}

${STYLE_RULES}`;
}

/** 테스트 전용 — 프롬프트 크기 측정에 쓴다. 런타임 코드는 쓰지 않는다. */
export const __promptsForTest = { system: buildAgentSystemPrompt };

// ── Chat system prompt ────────────────────────────────────────────────────────

export const DEFAULT_CHAT_SYSTEM_PROMPT = `너는 NekoDesk 어시스턴트야. 친근하고 간결하게 말해.
- 한국어로 답변해. 사용자가 다른 언어로 말하면 그 언어로 답해.
- 목록·비교는 마크다운 표를 써. 헤더 다음 줄에 구분선(| --- | --- |)을 꼭 넣고, 모든 행의 칸 수를 맞추고, 표를 \`\`\`로 감싸지 마.
- 응답 마지막에 반드시 [[PET_STATE:감정]] 형식으로 고양이 감정을 표시해. (idle/happy/curious/proud/sleepy/error 중 하나)
- 실제로 실행된 작업만 완료됐다고 해.
- 응답을 "네," 또는 "네!" 로 시작하지 마. 맞장구·동의 표현 없이 바로 본론으로 시작해.
- 말투는 처음부터 끝까지 반말(해체)로 통일해. 한 답변 안에서 존댓말과 반말을 섞지 마.
  금지 어미: ~습니다, ~합니다, ~됩니다, ~입니다, ~해요, ~예요, ~드릴게요, ~드릴게, ~세요.
  자기 지칭은 "나"/"내가". 3인칭으로 자기를 부르지 마.
  검색 결과나 인용 문서의 문체를 그대로 옮기지 말고 내용만 가져와서 네 말투로 다시 써.`;

const STATIC_TOOLS_BRIEF = `todo.list, todo.add, todo.complete, schedule.list, schedule.add, code.exec, web.search, web.scrape, weather.get`;

/** Returns base system prompt + dynamic tool list injected at the end. */
function buildChatSystemPrompt(): string {
  const base = useSettingsStore.getState().systemPrompt ?? DEFAULT_CHAT_SYSTEM_PROMPT;
  const dateSection = `\n현재 날짜/시각: ${nowKst()}`;

  const mcpEntries = getMcpTools();
  const mcpList = mcpEntries.length > 0
    ? "\n" + mcpEntries.map((e) => `- ${e.tool.name} [MCP:${e.serverName}]: ${e.tool.description}`).join("\n")
    : "";

  const toolsSection = `\n\n사용 가능한 도구 (사용자가 물어보면 목록을 알려줘):\n- 기본: ${STATIC_TOOLS_BRIEF}${mcpList}`;

  const profile = useSettingsStore.getState().userProfile?.trim();
  const profileSection = profile ? `\n사용자 프로필:\n${profile}` : "";

  return base + dateSection + profileSection + toolsSection;
}

// ── Core fetch ────────────────────────────────────────────────────────────────

/** LLM 요청 본문 조립. 스트리밍/비스트리밍이 같은 규칙을 쓰도록 한 곳에 모은다. */
function buildRequestBody(
  messages: LlmMessage[],
  params: LlmParams,
  defaultMaxTokens: number,
  stream: boolean
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    messages,
    max_tokens: params.max_tokens ?? defaultMaxTokens,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };
  if (params.grammar) body.grammar = params.grammar;
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.tools?.length) {
    body.tools = params.tools;
    body.tool_choice = "auto";
  }
  return body;
}

/** 비스트리밍 응답 한 건. reasoning 은 답변 본문이 아니라 사고 과정이다. */
export interface LlmCompletion {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
}

/** 비스트리밍 호출. 텍스트·사고 과정·툴 호출을 함께 돌려준다. */
export async function fetchCompletionMessage(
  messages: LlmMessage[],
  params: LlmParams = {},
  onUsage?: (promptTokens: number) => void,
  signal?: AbortSignal
): Promise<LlmCompletion> {
  const p = loadGenParams();
  const res = await fetch(`${getLlmUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRequestBody(messages, params, p.max_tokens_agent, false)),
    signal: abortAfterTimeout(signal),
  });

  if (!res.ok) {
    throw new Error(`LLM error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as {
    choices: Array<{
      message: {
        content: string;
        reasoning_content?: string;
        tool_calls?: WireToolCall[];
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  if (data.usage?.prompt_tokens !== undefined) {
    onUsage?.(data.usage.prompt_tokens);
  }
  const message = data.choices[0]?.message;
  return {
    text: message?.content ?? "",
    reasoning: message?.reasoning_content ?? "",
    toolCalls: fromWireToolCalls(message?.tool_calls),
  };
}

export async function fetchCompletion(
  messages: LlmMessage[],
  params: LlmParams = {},
  onUsage?: (promptTokens: number) => void,
  signal?: AbortSignal
): Promise<string> {
  return (await fetchCompletionMessage(messages, params, onUsage, signal)).text;
}

/** 서버가 보내는 tool_calls 델타의 원형. 첫 조각만 id·name 을 싣는다. */
interface WireToolCallDelta {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

function mapToolCallDeltas(
  deltas: WireToolCallDelta[] | undefined
): RawToolCallDelta[] | undefined {
  if (!deltas?.length) return undefined;
  return deltas.map((d) => ({
    index: d.index ?? 0,
    ...(d.id ? { id: d.id } : {}),
    ...(d.function?.name ? { name: d.function.name } : {}),
    ...(d.function?.arguments ? { argumentsFragment: d.function.arguments } : {}),
  }));
}

export async function* fetchStream(
  messages: LlmMessage[],
  params: LlmParams = {},
  onUsage?: (promptTokens: number) => void,
  signal?: AbortSignal
): AsyncGenerator<LlmStreamChunk> {
  const p = loadGenParams();
  const res = await fetch(`${getLlmUrl()}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRequestBody(messages, params, p.max_tokens_chat, true)),
    signal: abortAfterTimeout(signal),
  });

  if (!res.ok) {
    // 본문을 함께 싣는다. native tool calling 을 서버가 거부했는지(폴백 판정) 여기서
    // 알아야 한다 — 상태코드만으로는 이유를 구분할 수 없다.
    throw new Error(`LLM stream error ${res.status}: ${await res.text()}`);
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

  // 소비자가 루프를 벗어나거나(stop 버튼) abort 되면 generator 의 return() 이 불려
  // finally 가 실행된다. 그래야 llama.cpp 쪽 연결이 실제로 끊긴다.
  try {
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
            choices: Array<{
              delta: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: WireToolCallDelta[];
              };
              finish_reason: string | null;
            }>;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          };
          if (chunk.usage?.prompt_tokens !== undefined) {
            onUsage?.(chunk.usage.prompt_tokens);
          }
          // usage 전용 마지막 청크는 choices 가 비어 있다.
          const choice = chunk.choices[0];
          const finishReason = choice?.finish_reason ?? null;
          const finished = finishReason != null;
          // `--reasoning-format none` 으로 뜬 서버는 사고 과정을 content 안의
          // <think> 태그로 준다. 별도 필드로 주는 서버도 있어 둘 다 처리한다.
          const content = filterThink(choice?.delta?.content ?? "");
          const reasoning = choice?.delta?.reasoning_content ?? "";
          const toolCalls = mapToolCallDeltas(choice?.delta?.tool_calls);

          if (content || reasoning || toolCalls || finished) {
            yield {
              content,
              done: finished,
              finishReason,
              ...(reasoning ? { reasoning } : {}),
              ...(toolCalls ? { toolCalls } : {}),
            };
          }
          if (finished) return;
        } catch {
          // malformed chunk — skip
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
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

/**
 * finalAnswer 를 탐욕적으로 복구한다(최후의 수단).
 *
 * 모델이 finalAnswer 안에 마크다운 표나 따옴표(이스케이프 안 된)를 넣으면 JSON 이
 * 깨지고 엄격한 정규식도 실패한다. finalAnswer 는 출력 형식상 마지막 필드이므로,
 * 여는 따옴표부터 "마지막 } 직전의 마지막 따옴표"까지를 통째로 내용으로 본다.
 */
function looseFinalAnswer(json: string): string | null {
  const key = '"finalAnswer"';
  const ki = json.indexOf(key);
  if (ki === -1) return null;
  let i = ki + key.length;
  while (i < json.length && /\s/.test(json[i])) i++;
  if (json[i] !== ":") return null;
  i++;
  while (i < json.length && /\s/.test(json[i])) i++;
  if (json[i] !== '"') return null;
  i++; // 여는 따옴표 다음

  const rest = json.slice(i);
  const lastBrace = rest.lastIndexOf("}");
  const scope = lastBrace !== -1 ? rest.slice(0, lastBrace) : rest;
  const lastQuote = scope.lastIndexOf('"');
  const body = lastQuote !== -1 ? scope.slice(0, lastQuote) : scope;

  const unescaped = body
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
  return unescaped.trim() || null;
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
      needsConfirm: typeof parsed.needsConfirm === "boolean" ? parsed.needsConfirm : false,
      isDangerous: typeof parsed.isDangerous === "boolean" ? parsed.isDangerous : false,
      dangerReason: typeof parsed.dangerReason === "string" ? parsed.dangerReason : "",
    };
  } catch {
    // JSON parse failed (often due to max_tokens truncation or unescaped quotes in code).
    console.warn("[agentStep] JSON parse failed. raw:", raw, "| extracted:", json);

    // 1) 툴 호출 복구 먼저 (code 필드가 있으면). AppleScript "..." 문자열이 JSON 을
    //    깨뜨리는 흔한 경우. 답변(finalAnswer)보다 툴을 우선 판정한다.
    const toolMatch = json.match(/"tool"\s*:\s*"([^"]+)"/);
    const langMatch = json.match(/"language"\s*:\s*"([^"]+)"/);
    const codeStart = json.indexOf('"code"');
    if (toolMatch && codeStart !== -1) {
      const toolName = toolMatch[1];
      if (isValidTool(toolName) && toolName !== "none") {
        // Reliably find the opening " of the code value by scanning for : then "
        const afterCodeKey = json.slice(codeStart + '"code"'.length);
        const colonIdx = afterCodeKey.indexOf(':');
        if (colonIdx !== -1) {
          const afterColon = afterCodeKey.slice(colonIdx + 1);
          const openQuoteIdx = afterColon.indexOf('"');
          if (openQuoteIdx !== -1) {
            const codeBody = afterColon.slice(openQuoteIdx + 1); // skip opening "
            const endMarker = langMatch
              ? codeBody.lastIndexOf(`","language"`)
              : codeBody.lastIndexOf('"}');
            const code = endMarker !== -1
              ? codeBody.slice(0, endMarker).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"')
              : codeBody.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"');
            return {
              thought: "",
              tool: toolName,
              params: { code, language: langMatch?.[1] ?? "applescript" },
            };
          }
        }
      }
    }

    // 2) finalAnswer 탐욕적 복구 (표·이스케이프 안 된 따옴표로 JSON 이 깨진 답변).
    const loose = looseFinalAnswer(json);
    if (loose) {
      return { thought: "응답 파싱 실패", tool: "none", params: {}, finalAnswer: loose };
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
  "file.upload", "weather.get", "user.ask", "game.start", "none",
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

/** 매 호출 바뀌는 컨텍스트(시각 + 상황별 지식). 시스템 프롬프트가 아니라 현재
 *  user 메시지 앞에 붙여, 큰 정적 시스템 프롬프트의 프롬프트 캐시를 보존한다. */
function buildAgentContextPrefix(userInput: string, recentContext: string): string {
  const knowledge = buildKnowledgeSection(userInput, recentContext);
  return `[현재 날짜/시각: ${nowKst()}]${knowledge}\n\n`;
}

/** messages 배열에서 마지막 user 메시지 앞에 컨텍스트 프리픽스를 끼운다.
 *  멀티모달(content 배열)이면 맨 앞에 text 파트로 추가한다. */
function injectContextIntoLastUser(messages: LlmMessage[], prefix: string): LlmMessage[] {
  const out = [...messages];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== "user") continue;
    const c = out[i].content;
    out[i] = {
      ...out[i],
      content:
        typeof c === "string"
          ? prefix + c
          : [{ type: "text", text: prefix }, ...c],
    };
    break;
  }
  return out;
}

function buildAgentMessages(
  messages: LlmMessage[],
  userInput: string,
  native: boolean
): LlmMessage[] {
  // 최근 5개 user 메시지 텍스트를 context로 추출해 knowledge 주입에 활용
  const recentUserContext = messages
    .filter((m) => m.role === "user")
    .slice(-5)
    .map((m) => (typeof m.content === "string" ? m.content : ""))
    .join(" ");
  // 시스템 프롬프트는 고정(캐시됨), 시각·지식은 현재 user 메시지에 붙인다.
  const systemMessage: LlmMessage = {
    role: "system",
    content: buildAgentSystemPrompt(native),
  };
  const prefix = buildAgentContextPrefix(userInput, recentUserContext);
  return [systemMessage, ...injectContextIntoLastUser(messages, prefix)];
}

export type AgentStepEvent =
  | { type: "thinking"; text: string }
  | { type: "delta"; text: string }
  | { type: "parsed"; parsed: ParsedAgentStep };

/**
 * agentStep 을 스트리밍으로 수행한다.
 *
 * 모델은 JSON 한 덩어리를 뱉지만, 그 안의 `finalAnswer` 문자열은 도착하는 대로
 * `delta` 로 흘려보낸다. 추가 LLM 호출 없이 진짜 스트리밍이 된다.
 * 최종 파싱은 기존 `parseAgentResponse` 가 그대로 담당하므로, 복구 파서가
 * 다른 답을 내놓더라도 소비자의 `done` 이벤트에서 내용이 덮어써져 자기교정된다.
 */
export async function* agentStepStream(
  messages: LlmMessage[],
  userInput = "",
  onUsage?: (promptTokens: number) => void,
  signal?: AbortSignal
): AsyncGenerator<AgentStepEvent> {
  const allMessages = buildAgentMessages(messages, userInput, false);
  const p = loadGenParams();
  // JSON 에서 thought 가 finalAnswer 보다 먼저 나온다. 둘 다 도착하는 대로 흘려
  // thought 는 "생각 중" 표시로, finalAnswer 는 답변으로 스트리밍한다.
  const thoughtStreamer = createJsonStringFieldStreamer("thought");
  const answerStreamer = createJsonStringFieldStreamer("finalAnswer");

  let raw = "";
  // 서버가 reasoning 을 별도 필드로 뽑아내면(`--reasoning-format` 이 none 이 아닐 때)
  // grammar 로 강제한 JSON 이 통째로 그쪽으로 간다. content 는 빈 채로 끝나므로
  // 이걸 안 받아두면 "응답을 해석하지 못했어" 로 죽는다.
  let reasoningRaw = "";
  let emitted = 0;
  try {
    for await (const chunk of fetchStream(
      allMessages,
      { temperature: 0.1, max_tokens: p.max_tokens_agent, grammar: AGENT_JSON_GRAMMAR },
      onUsage,
      signal
    )) {
      if (chunk.reasoning) {
        reasoningRaw += chunk.reasoning;
        yield { type: "thinking", text: chunk.reasoning };
      }
      if (!chunk.content) continue;
      raw += chunk.content;
      const thinking = thoughtStreamer.push(chunk.content);
      if (thinking) yield { type: "thinking", text: thinking };
      const delta = answerStreamer.push(chunk.content);
      if (delta) {
        emitted += delta.length;
        yield { type: "delta", text: delta };
      }
    }
  } catch (err) {
    // 이미 답을 흘려보낸 뒤 끊겼다면 되돌릴 수 없다. 그대로 올린다.
    if (emitted > 0) throw err;
    // 아직 아무것도 안 보냈으면 비스트리밍 경로로 한 번 더(이미지 폴백 포함).
    yield { type: "parsed", parsed: await agentStep(messages, userInput, onUsage, signal) };
    return;
  }

  yield { type: "parsed", parsed: parseAgentResponse(raw.trim() ? raw : reasoningRaw) };
}

export async function agentStep(
  messages: LlmMessage[],
  userInput = "",
  onUsage?: (promptTokens: number) => void,
  signal?: AbortSignal
): Promise<ParsedAgentStep> {
  const allMessages = buildAgentMessages(messages, userInput, false);

  try {
    const done = await fetchCompletionMessage(
      allMessages,
      { temperature: 0.1, grammar: AGENT_JSON_GRAMMAR },
      onUsage,
      signal
    );
    return parseAgentResponse(done.text.trim() ? done.text : done.reasoning);
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
        const retry = await fetchCompletionMessage(
          fallback,
          { temperature: 0.1, grammar: AGENT_JSON_GRAMMAR },
          onUsage,
          signal
        );
        return parseAgentResponse(retry.text.trim() ? retry.text : retry.reasoning);
      }
    }
    throw err;
  }
}

// ── Agent turn (native tool calling + json 폴백) ───────────────────────────────

/**
 * 한 턴의 스트리밍 이벤트. native 든 json 이든 소비자(agent-loop)는 같은 모양을 본다.
 *  - thinking: 모델의 사고 과정 (답변 아님)
 *  - delta:    답변 본문 조각
 *  - turn:     확정된 턴 (텍스트 + 툴 호출 목록)
 */
export type AgentTurnEvent =
  | { type: "thinking"; text: string }
  | { type: "delta"; text: string }
  | { type: "turn"; turn: AgentTurn };

/** 서버가 `tools` 파라미터를 거부했는가. 4xx 만 폴백 대상 — 5xx 는 일시적 장애다. */
function isNativeToolsRejected(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /LLM (stream )?error (400|404|422|501)\b/.test(msg);
}

function isImageError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("failed to process image") || msg.includes("500");
}

/** json 모드의 단일 스텝 결과를 공통 AgentTurn 으로 변환한다. */
function stepToTurn(parsed: ParsedAgentStep, seq: number): AgentTurn {
  // finalAnswer 가 있으면 tool 값과 무관하게 종료 턴이다(복구 파서가 둘 다 채우는 경우).
  if (parsed.tool === "none" || !parsed.tool || parsed.finalAnswer) {
    return { text: parsed.finalAnswer ?? parsed.thought, toolCalls: [] };
  }
  return {
    text: parsed.thought,
    toolCalls: [{ id: `json_${seq}`, name: parsed.tool, params: parsed.params }],
  };
}

/** native 비스트리밍 경로. 이미지 처리 실패 시 이미지를 빼고 한 번 재시도한다. */
async function nativeTurn(
  messages: LlmMessage[],
  userInput: string,
  onUsage?: (promptTokens: number) => void,
  signal?: AbortSignal
): Promise<AgentTurn> {
  const allMessages = buildAgentMessages(messages, userInput, true);
  const params: LlmParams = { temperature: 0.1, tools: buildToolSchemas() };

  const toTurn = ({ text, toolCalls }: LlmCompletion): AgentTurn => ({ text, toolCalls });

  try {
    return toTurn(await fetchCompletionMessage(allMessages, params, onUsage, signal));
  } catch (err) {
    if (!isImageError(err)) throw err;
    const { messages: fallback, hadImages } = stripImageParts(allMessages);
    if (!hadImages) throw err;
    const note = fallback[fallback.length - 1];
    if (note && typeof note.content === "string") {
      note.content = `${note.content}\n\n[이미지를 첨부했지만 현재 모델이 이미지를 지원하지 않아요.]`;
    }
    return toTurn(await fetchCompletionMessage(fallback, params, onUsage, signal));
  }
}

/**
 * native 스트리밍 경로.
 *
 * 서버가 tool_calls 를 조각내서 보내므로 ToolCallAccumulator 로 조립한다. 툴 호출이
 * 하나도 없으면 흘려보낸 텍스트가 그대로 최종 답변이다.
 */
async function* nativeTurnStream(
  messages: LlmMessage[],
  userInput: string,
  onUsage?: (promptTokens: number) => void,
  signal?: AbortSignal
): AsyncGenerator<AgentTurnEvent> {
  const allMessages = buildAgentMessages(messages, userInput, true);
  const p = loadGenParams();
  const accumulator = new ToolCallAccumulator();
  let text = "";
  let emitted = 0;

  try {
    for await (const chunk of fetchStream(
      allMessages,
      { temperature: 0.1, max_tokens: p.max_tokens_agent, tools: buildToolSchemas() },
      onUsage,
      signal
    )) {
      if (chunk.reasoning) {
        emitted++;
        yield { type: "thinking", text: chunk.reasoning };
      }
      if (chunk.toolCalls) accumulator.push(chunk.toolCalls);
      if (chunk.content) {
        text += chunk.content;
        emitted++;
        yield { type: "delta", text: chunk.content };
      }
      if (chunk.done) break;
    }
  } catch (err) {
    // 이미 흘려보낸 뒤 끊겼다면 되돌릴 수 없다. 그대로 올린다.
    if (emitted > 0) throw err;
    yield { type: "turn", turn: await nativeTurn(messages, userInput, onUsage, signal) };
    return;
  }

  yield { type: "turn", turn: { text: text.trim(), toolCalls: accumulator.finish() } };
}

/**
 * 에이전트 한 턴 — 모드 선택과 폴백을 여기서 흡수한다.
 *
 * auto 모드에서 서버가 `tools` 를 거부하면(예: `--jinja` 없이 뜬 llama-server,
 * 툴 템플릿이 없는 모델) 이 세션 동안 json 모드로 강등하고 같은 턴을 다시 시도한다.
 * 아직 아무것도 흘려보내지 않은 시점에만 강등하므로 사용자에겐 이어져 보인다.
 */
export async function* agentTurnStream(
  messages: LlmMessage[],
  userInput = "",
  turnSeq = 0,
  onUsage?: (promptTokens: number) => void,
  signal?: AbortSignal
): AsyncGenerator<AgentTurnEvent> {
  if (shouldUseNativeTools()) {
    let emitted = 0;
    try {
      for await (const ev of nativeTurnStream(messages, userInput, onUsage, signal)) {
        emitted++;
        yield ev;
      }
      return;
    } catch (err) {
      if (emitted > 0 || !isNativeToolsRejected(err)) throw err;
      console.warn("[tools] 서버가 native tool calling 을 거부해 json 모드로 강등:", err);
      useSettingsStore.getState().setNativeToolsDegraded(true);
    }
  }

  for await (const ev of agentStepStream(messages, userInput, onUsage, signal)) {
    if (ev.type === "parsed") yield { type: "turn", turn: stepToTurn(ev.parsed, turnSeq) };
    else yield ev;
  }
}

// ── Chat response (streaming) ─────────────────────────────────────────────────

export function chatStream(
  messages: LlmMessage[],
  toolContext: string,
  onUsage?: (promptTokens: number) => void,
  signal?: AbortSignal
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

  return fetchStream(allMessages, { temperature: 0.7, max_tokens: 512 }, onUsage, signal);
}

// ── Mini-game ─────────────────────────────────────────────────────────────────

const FALLBACK_WORDS = [
  "고양이", "강아지", "집", "자동차", "나무", "피자", "기타", "달", "물고기",
  "컵", "사과", "토끼", "책", "전화기", "케이크", "비행기", "자전거", "꽃",
  "수박", "카메라",
];

export async function generateGameWords(count: number): Promise<string[]> {
  try {
    const raw = await fetchCompletion([
      {
        role: "system",
        content: "그림 맞추기 게임 단어 생성기. JSON 배열만 출력. 다른 텍스트 없음.",
      },
      {
        role: "user",
        content: `그림으로 그리기 쉬운 한국어 명사 ${count}개를 JSON 배열로 출력해. 동물/음식/사물/자연물 위주, 중복 없이, 매번 다양하게.`,
      },
    ], { temperature: 1.0, max_tokens: 150 });

    console.log("[generateGameWords] raw:", raw);

    // 코드블록 제거 후 JSON 배열 추출
    const cleaned = raw.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "");
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]) as unknown[];
      if (Array.isArray(arr) && arr.length > 0) {
        const words = arr.map(String).filter((w) => /[가-힣]/.test(w));
        if (words.length >= count) return words.slice(0, count);
        if (words.length > 0) return words; // 부족해도 있는 만큼 사용
      }
    }
    console.warn("[generateGameWords] parse failed, raw:", raw);
  } catch (e) {
    console.error("[generateGameWords] error:", e);
  }
  return [...FALLBACK_WORDS].sort(() => Math.random() - 0.5).slice(0, count);
}

export async function guessDrawing(imageDataUrl: string): Promise<string> {
  const raw = await fetchCompletion([{
    role: "user",
    content: [
      { type: "image_url", image_url: { url: imageDataUrl } },
      { type: "text", text: "이 그림이 뭔지 한국어 명사 하나만 답해줘. 설명 없이 단어만." },
    ],
  }], { temperature: 0.2, max_tokens: 20 });
  const korean = raw.match(/[가-힣]+/);
  return korean ? korean[0] : (raw.trim().split(/\s/)[0] ?? "모르겠어");
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
        const dgs = props.default_generation_settings as Record<string, unknown> | undefined;
        const nCtx = typeof props.n_ctx === "number"
          ? props.n_ctx
          : typeof dgs?.n_ctx === "number"
          ? dgs.n_ctx
          : undefined;
        return {
          id: first.id,
          context_length: nCtx,
          n_params: typeof props.total_params === "number" ? props.total_params : undefined,
        };
      }
    } catch { /* props optional */ }
    return { id: first.id };
  } catch {
    return null;
  }
}

// ── Word chain game ───────────────────────────────────────────────────────────

export async function wordChainReply(
  lastChar: string,
  usedWords: string[],
  validateWord?: string,
): Promise<string> {
  const usedStr = usedWords.length > 0 ? ` 이미 사용된 단어: [${usedWords.join(", ")}].` : "";

  // 유저 단어 검증 + 고양이 응답을 한 번의 LLM 호출로 처리
  const prompt = validateWord
    ? `끝말잇기 게임이야. 유저가 "${validateWord}"를 냈어.
이 단어가 실제 한국어 사전에 있는 단어인지 먼저 판단해.
- 실존하는 단어라면: "${lastChar}"로 시작하는 한국어 명사 하나만 답해줘. 두음법칙 적용 가능.${usedStr}
- 실존하지 않는 단어라면: INVALID 라고만 답해.
설명 없이 단어 또는 INVALID만.`
    : lastChar
    ? `끝말잇기 게임이야. 반드시 "${lastChar}"로 시작하는 한국어 명사 단어 하나만 답해줘. 반드시 두 글자 이상이어야 해. 두음법칙 적용 가능 (예: '녕'→'영', '렬'→'열', '뇨'→'요').${usedStr} 설명 없이 단어만.`
    : `끝말잇기 게임 시작! 한국어 명사 하나만 답해줘. 반드시 두 글자 이상이어야 해. 설명 없이 단어만.`;

  const MAX_TRIES = 5;
  for (let i = 0; i < MAX_TRIES; i++) {
    const raw = (await fetchCompletion(
      [{ role: "user", content: prompt }],
      { max_tokens: 20, temperature: 0.9 }
    )).trim();
    if (raw.toUpperCase().includes("INVALID")) return "INVALID";
    const candidates = (raw.match(/[가-힣]+/g) ?? []).filter(w => w.length >= 2).map(w => w.slice(0, 10));
    // lastChar로 시작하는 단어 우선, 없으면 첫 번째 후보
    const word = (lastChar ? candidates.find(w => w[0] === lastChar) : candidates[0]) ?? candidates[0] ?? "";
    if (word.length >= 2) return word;
  }
  return "";
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

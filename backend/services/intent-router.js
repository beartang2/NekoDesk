const EXIT_PATTERN = /^\/exit$/i;
const HELP_PATTERN = /^\/help$/i;
const REFRESH_PATTERN = /^\/refresh$/i;
const EXPLICIT_WEB_SEARCH_PATTERN =
  /(웹에서|인터넷에서|온라인에서|duckduckgo|덕덕고|검색해줘|검색해 봐|검색해봐|검색해|찾아봐|찾아 봐|찾아줘|알아봐|look up|lookup|search the web|search online|google|구글링)/i;
const CURRENT_INFO_PATTERN =
  /(최신|최근|뉴스|소식|실시간|업데이트|날씨|주가|가격|환율|today|latest|recent|news|weather|stock|price|exchange rate|current)/i;
const TROUBLESHOOTING_PATTERN =
  /(오류|에러|에러 메시지|에러메시지|에러 코드|error|error message|error code|exception|stack trace)/i;
const INFO_REQUEST_PATTERN = /(뭐야|뭐지|어때|알려줘|보여줘|찾아줘|찾아봐|검색|알아봐|\?)$/i;
const LOCAL_APP_DATA_PATTERN =
  /(메모|할 일|할일|todo|일정|schedule|캘린더|calendar|내 github|내 깃허브|github 상태|깃허브 상태|review request|notification|pull request|\bpr\b|\brepo\b)/i;

export async function routeIntent(input, llmClient, options = {}) {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      type: "help",
      confidence: 1,
      params: {},
      replyHint: "무엇을 도와줄지 알려줘."
    };
  }

  if (EXIT_PATTERN.test(trimmed)) {
    return { type: "system.exit", confidence: 1, params: {} };
  }

  if (HELP_PATTERN.test(trimmed)) {
    return { type: "help", confidence: 1, params: {} };
  }

  if (REFRESH_PATTERN.test(trimmed)) {
    return { type: "system.refresh", confidence: 1, params: {} };
  }

  const deterministicWebIntent = inferWebSearchIntent(trimmed);
  if (deterministicWebIntent) {
    return deterministicWebIntent;
  }

  const llmIntent = await llmClient.parseIntent(trimmed, {
    activeView: options.activeView || "chat",
    currentDateTime: options.currentDateTime || new Date().toISOString(),
    timezone: options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  });

  if (llmIntent) {
    if (isUnsafeSystemIntent(llmIntent.type, trimmed)) {
      return {
        type: "chat",
        confidence: 0.4,
        params: { message: trimmed }
      };
    }

    return llmIntent;
  }

  return {
    type: "chat",
    confidence: 0.5,
    params: { message: trimmed }
  };
}

function inferWebSearchIntent(input) {
  const trimmed = input.trim();
  if (!trimmed || LOCAL_APP_DATA_PATTERN.test(trimmed)) {
    return null;
  }

  if (EXPLICIT_WEB_SEARCH_PATTERN.test(trimmed)) {
    return {
      type: "web.search",
      confidence: 0.98,
      params: { query: trimmed }
    };
  }

  if (TROUBLESHOOTING_PATTERN.test(trimmed)) {
    return {
      type: "web.search",
      confidence: 0.9,
      params: { query: trimmed }
    };
  }

  if (CURRENT_INFO_PATTERN.test(trimmed) && INFO_REQUEST_PATTERN.test(trimmed)) {
    return {
      type: "web.search",
      confidence: 0.86,
      params: { query: trimmed }
    };
  }

  return null;
}

function isUnsafeSystemIntent(type, input) {
  if (type === "system.exit") {
    return !EXIT_PATTERN.test(input);
  }

  if (type === "help") {
    return !HELP_PATTERN.test(input);
  }

  if (type === "system.refresh") {
    return !REFRESH_PATTERN.test(input);
  }

  return false;
}

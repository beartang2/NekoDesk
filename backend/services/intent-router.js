const EXIT_PATTERN = /^\/exit$/i;
const HELP_PATTERN = /^\/help$/i;
const REFRESH_PATTERN = /^\/refresh$/i;

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

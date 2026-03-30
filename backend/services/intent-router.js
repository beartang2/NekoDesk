const EXIT_PATTERN = /^(exit|quit|종료)$/i;
const HELP_PATTERN = /^(help|도움말|명령어)$/i;
const REFRESH_PATTERN = /^(refresh|새로고침|갱신)$/i;

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
    return { type: "system.refresh", confidence: 0.95, params: {} };
  }

  const llmIntent = await llmClient.parseIntent(trimmed, {
    activeView: options.activeView || "chat",
    currentDateTime: options.currentDateTime || new Date().toISOString(),
    timezone: options.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  });

  if (llmIntent) {
    return llmIntent;
  }

  return {
    type: "chat",
    confidence: 0.5,
    params: { message: trimmed }
  };
}

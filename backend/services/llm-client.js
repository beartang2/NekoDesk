const FASTAPI_CHAT_URL = "http://127.0.0.1:8000/chat";

function stripCodeFence(value) {
  return value.replace(/```json|```/gi, "").trim();
}

function stripInternalReasoning(value) {
  return value
    .replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, " ")
    .replace(/<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi, " ")
    .replace(/<reasoning\b[^>]*>[\s\S]*?<\/reasoning>/gi, " ")
    .trim();
}

export class LLMClient {
  constructor(config) {
    this.config = config;
  }

  async chat(messages, systemPrompt, context = {}) {
    try {
      const requestContext = buildRequestContext(context);
      const normalizedMessages = normalizeMessages(messages);
      const resolvedSystemPrompt = systemPrompt || this.config.chatSystemPrompt;
      const response = await this.#callChatApi({
        systemPrompt: resolvedSystemPrompt,
        messages: normalizedMessages,
        activeView: requestContext.activeView,
        temperature: this.config.chatTemperature,
        maxTokens: this.config.maxTokens,
        timeoutMs: this.config.timeoutMs,
        currentDateTime: requestContext.currentDateTime,
        timezone: requestContext.timezone,
        headers: this.config.headers,
        requestBody: this.config.requestBody
      });
      if (shouldRetryReplyInKorean(normalizedMessages, response)) {
        const retried = await this.#retryReplyInKorean(
          response,
          normalizedMessages,
          resolvedSystemPrompt,
          requestContext
        );
        return retried || response || this.config.fallbackReply;
      }

      return response || this.config.fallbackReply;
    } catch (error) {
      logLlmError("chat", error, this.config.timeoutMs);
      return buildConnectionErrorReply(error, this.config);
    }
  }

  async parseIntent(input, context = {}) {
    try {
      const requestContext = buildRequestContext(context);
      const contextLines = [
        `activeView: ${requestContext.activeView}`,
        `currentLocalDateTime: ${requestContext.currentDateTime}`,
        `timezone: ${requestContext.timezone}`
      ].join("\n");

      const content = await this.#callChatApi({
        systemPrompt: this.config.intentSystemPrompt,
        messages: [
          {
            role: "user",
            content: `${contextLines}\nuserInput: ${input}`
          }
        ],
        activeView: requestContext.activeView,
        temperature: this.config.intentTemperature,
        maxTokens: this.config.intentMaxTokens,
        timeoutMs: this.config.timeoutMs,
        currentDateTime: requestContext.currentDateTime,
        timezone: requestContext.timezone,
        headers: this.config.headers,
        requestBody: this.config.requestBody
      });

      const parsed = JSON.parse(stripCodeFence(content));
      if (!parsed || typeof parsed.type !== "string") {
        return null;
      }

      return {
        type: parsed.type,
        confidence: Number(parsed.confidence || 0.4),
        params: parsed.params || {}
      };
    } catch (error) {
      logLlmError("intent", error, this.config.timeoutMs);
      return null;
    }
  }

  async planToolUse(messages, context = {}) {
    try {
      const requestContext = buildRequestContext(context);
      const transcript = normalizeMessages(messages)
        .map((message) => `${message.role}: ${message.content}`)
        .join("\n");

      const content = await this.#callChatApi({
        systemPrompt: this.config.toolPlanSystemPrompt,
        messages: [
          {
            role: "user",
            content: [
              `activeView: ${requestContext.activeView}`,
              `currentLocalDateTime: ${requestContext.currentDateTime}`,
              `timezone: ${requestContext.timezone}`,
              "conversation:",
              transcript || "(empty)"
            ].join("\n")
          }
        ],
        activeView: requestContext.activeView,
        temperature: this.config.toolPlanTemperature,
        maxTokens: this.config.toolPlanMaxTokens,
        timeoutMs: this.config.timeoutMs,
        currentDateTime: requestContext.currentDateTime,
        timezone: requestContext.timezone,
        headers: this.config.headers,
        requestBody: this.config.requestBody
      });

      const parsed = JSON.parse(stripCodeFence(content));
      if (!parsed || parsed.useTool !== true || !parsed.intent || typeof parsed.intent.type !== "string") {
        return null;
      }

      return {
        type: parsed.intent.type,
        confidence: Number(parsed.intent.confidence || 0.4),
        params: parsed.intent.params || {}
      };
    } catch (error) {
      logLlmError("tool_plan", error, this.config.timeoutMs);
      return null;
    }
  }

  async #callChatApi({
    systemPrompt,
    messages,
    activeView,
    temperature,
    maxTokens,
    timeoutMs,
    currentDateTime,
    timezone,
    headers,
    requestBody
  }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const body = {
        system_prompt: systemPrompt,
        messages,
        model: this.config.model,
        active_view: activeView,
        temperature,
        max_tokens: maxTokens,
        timeout_ms: timeoutMs,
        current_datetime: currentDateTime,
        timezone,
        headers: headers || {},
        request_body: requestBody || {}
      };

      const response = await fetch(FASTAPI_CHAT_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        const error = new Error(`LLM HTTP ${response.status}`);
        error.name = "LLMHttpError";
        error.status = response.status;
        throw error;
      }

      const payload = await response.json();
      return extractContent(payload);
    } finally {
      clearTimeout(timeout);
    }
  }

  async #retryReplyInKorean(originalReply, messages, systemPrompt, requestContext) {
    try {
      return await this.#callChatApi({
        systemPrompt: buildKoreanRetrySystemPrompt(systemPrompt),
        messages: [
          ...messages,
          { role: "assistant", content: originalReply },
          {
            role: "user",
            content:
              "Rewrite your last reply in natural Korean only. Keep the meaning. Do not use Chinese. Return only the rewritten reply."
          }
        ],
        activeView: requestContext.activeView,
        temperature: this.config.chatTemperature,
        maxTokens: this.config.maxTokens,
        timeoutMs: this.config.timeoutMs,
        currentDateTime: requestContext.currentDateTime,
        timezone: requestContext.timezone,
        headers: this.config.headers,
        requestBody: this.config.requestBody
      });
    } catch (error) {
      logLlmError("chat_korean_retry", error, this.config.timeoutMs);
      return null;
    }
  }
}

function normalizeMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: message.content
  }));
}

function buildRequestContext(context = {}) {
  return {
    activeView: context.activeView || "chat",
    currentDateTime: context.currentDateTime || new Date().toISOString(),
    timezone: context.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  };
}

function extractContent(payload) {
  if (typeof payload?.content === "string" && payload.content.trim()) {
    const normalized = stripInternalReasoning(payload.content.trim());
    return normalized || null;
  }

  const legacyContent = payload?.choices?.[0]?.message?.content;
  if (typeof legacyContent === "string" && legacyContent.trim()) {
    const normalized = stripInternalReasoning(legacyContent.trim());
    return normalized || null;
  }

  return null;
}

function buildKoreanRetrySystemPrompt(systemPrompt) {
  return [
    systemPrompt,
    "Critical language rule: if the user is speaking Korean, the final user-facing answer must be written in Korean.",
    "Do not answer in Chinese unless the user explicitly requested Chinese.",
    "Return only the Korean rewrite."
  ].join("\n");
}

function shouldRetryReplyInKorean(messages, reply) {
  if (!reply || typeof reply !== "string") {
    return false;
  }

  if (!looksLikeKoreanConversation(messages)) {
    return false;
  }

  if (containsHangul(reply)) {
    return false;
  }

  return countHanCharacters(reply) >= 2;
}

function looksLikeKoreanConversation(messages) {
  return messages.some((message) => containsHangul(message?.content || ""));
}

function containsHangul(value) {
  return /[\p{Script=Hangul}]/u.test(value);
}

function countHanCharacters(value) {
  const matches = value.match(/[\p{Script=Han}]/gu);
  return matches ? matches.length : 0;
}

function buildConnectionErrorReply(error, config) {
  const details = describeLlmError(error, config.timeoutMs);
  return `${config.connectionErrorReply} (${details.userMessage})`;
}

function logLlmError(scope, error, timeoutMs) {
  const details = describeLlmError(error, timeoutMs);
  console.error(`[LLM:${scope}] ${details.logMessage}`);
}

function describeLlmError(error, timeoutMs) {
  if (error?.name === "AbortError") {
    return {
      userMessage: `응답 시간이 ${timeoutMs}ms를 넘어 중단됐어`,
      logMessage: `request timed out after ${timeoutMs}ms`
    };
  }

  if (error?.name === "LLMHttpError" && Number.isFinite(error.status)) {
    return {
      userMessage: `서버가 HTTP ${error.status}를 반환했어`,
      logMessage: `server returned HTTP ${error.status}`
    };
  }

  if (error instanceof SyntaxError) {
    return {
      userMessage: "응답 형식을 해석하지 못했어",
      logMessage: `failed to parse response: ${error.message}`
    };
  }

  return {
    userMessage: error?.message || "알 수 없는 오류가 발생했어",
    logMessage: error?.stack || error?.message || "unknown error"
  };
}

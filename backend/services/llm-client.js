function stripCodeFence(value) {
  return value.replace(/```json|```/gi, "").trim();
}

export class LLMClient {
  constructor(config) {
    this.config = config;
  }

  async chat(messages, systemPrompt) {
    try {
      const response = await this.#callChatApi(
        systemPrompt || this.config.chatSystemPrompt,
        messages.map((message) => ({
          role: message.role,
          content: message.content
        })),
        {
          temperature: this.config.chatTemperature,
          maxTokens: this.config.maxTokens
        }
      );
      return response || this.config.fallbackReply;
    } catch {
      return this.config.connectionErrorReply;
    }
  }

  async parseIntent(input, context = {}) {
    try {
      const contextLines = [
        `activeView: ${context.activeView || "chat"}`,
        `currentLocalDateTime: ${context.currentDateTime || new Date().toISOString()}`,
        `timezone: ${context.timezone || "UTC"}`
      ].join("\n");
      const content = await this.#callChatApi(
        this.config.intentSystemPrompt,
        [
          {
            role: "user",
            content: `${contextLines}\nuserInput: ${input}`
          }
        ],
        {
          temperature: this.config.intentTemperature,
          maxTokens: this.config.maxTokens
        }
      );
      const parsed = JSON.parse(stripCodeFence(content));
      if (!parsed || typeof parsed.type !== "string") {
        return null;
      }
      return {
        type: parsed.type,
        confidence: Number(parsed.confidence || 0.4),
        params: parsed.params || {}
      };
    } catch {
      return null;
    }
  }

  async #callChatApi(systemPrompt, messages, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const body = {
        ...this.config.requestBody,
        model: options.model || this.config.model,
        temperature: options.temperature ?? this.config.chatTemperature,
        messages: [
          { role: "system", content: systemPrompt },
          ...messages
        ]
      };

      if (options.maxTokens !== undefined) {
        body.max_tokens = options.maxTokens;
      }

      const response = await fetch(resolveApiUrl(this.config.baseUrl, this.config.apiPath), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.config.headers
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`LLM HTTP ${response.status}`);
      }

      const payload = await response.json();
      return payload.choices?.[0]?.message?.content?.trim() || null;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function resolveApiUrl(baseUrl, apiPath) {
  return new URL(apiPath, `${baseUrl}/`).toString();
}

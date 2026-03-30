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
        systemPrompt,
        messages.map((message) => ({
          role: message.role,
          content: message.content
        }))
      );
      return response || "지금은 잠깐 생각이 꼬였어. 다시 한 번 말해줄래?";
    } catch {
      return "LLM 서버와 연결되지 않았어. 메모나 할 일 같은 로컬 기능은 계속 사용할 수 있어.";
    }
  }

  async parseIntent(input) {
    try {
      const content = await this.#callChatApi(
        [
          "You classify terminal assistant intents.",
          "Return strict JSON only.",
          'Schema: {"type":"chat|github.overview|schedule.listUpcoming|schedule.listDay|memo.list|todo.list|help","confidence":0.0,"params":{}}'
        ].join("\n"),
        [{ role: "user", content: input }],
        { temperature: 0.1 }
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
      const response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: options.temperature ?? 0.3,
          messages: [
            { role: "system", content: systemPrompt },
            ...messages
          ]
        }),
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

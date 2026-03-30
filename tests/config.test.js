import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../backend/config.js";

test("loadConfig applies llm env overrides", () => {
  const originalEnv = { ...process.env };

  try {
    process.env.NEKODESK_LLM_URL = "http://localhost:9999/";
    process.env.NEKODESK_LLM_API_PATH = "/custom/chat";
    process.env.NEKODESK_LLM_CHAT_TEMPERATURE = "0.55";
    process.env.NEKODESK_LLM_INTENT_TEMPERATURE = "0.05";
    process.env.NEKODESK_LLM_HISTORY_LIMIT = "5";
    process.env.NEKODESK_LLM_HEADERS_JSON = '{"Authorization":"Bearer test"}';
    process.env.NEKODESK_LLM_BODY_JSON = '{"top_p":0.8}';
    process.env.NEKODESK_LLM_CHAT_SYSTEM_PROMPT = "custom chat prompt";

    const config = loadConfig();

    assert.equal(config.llm.baseUrl, "http://localhost:9999");
    assert.equal(config.llm.apiPath, "/custom/chat");
    assert.equal(config.llm.chatTemperature, 0.55);
    assert.equal(config.llm.intentTemperature, 0.05);
    assert.equal(config.llm.historyLimit, 5);
    assert.deepEqual(config.llm.headers, { Authorization: "Bearer test" });
    assert.deepEqual(config.llm.requestBody, { top_p: 0.8 });
    assert.equal(config.llm.chatSystemPrompt, "custom chat prompt");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("loadConfig can read prompt text from file", () => {
  const originalEnv = { ...process.env };
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nekodesk-prompt-"));
  const promptPath = path.join(tempDir, "chat-prompt.txt");

  try {
    fs.writeFileSync(promptPath, "file based prompt", "utf8");
    process.env.NEKODESK_LLM_CHAT_SYSTEM_PROMPT_FILE = promptPath;
    delete process.env.NEKODESK_LLM_CHAT_SYSTEM_PROMPT;

    const config = loadConfig();
    assert.equal(config.llm.chatSystemPrompt, "file based prompt");
  } finally {
    restoreEnv(originalEnv);
  }
});

function restoreEnv(originalEnv) {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, originalEnv);
}

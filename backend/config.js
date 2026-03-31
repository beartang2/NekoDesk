import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_CHAT_FALLBACK_REPLY,
  DEFAULT_CHAT_TEMPERATURE,
  DEFAULT_CHAT_SYSTEM_PROMPT,
  DEFAULT_CONNECTION_ERROR_REPLY,
  DEFAULT_GITHUB_QUERY_SYSTEM_PROMPT,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_INTENT_MAX_TOKENS,
  DEFAULT_INTENT_SYSTEM_PROMPT,
  DEFAULT_INTENT_TEMPERATURE,
  DEFAULT_LLM_API_PATH,
  DEFAULT_TOOL_PLAN_MAX_TOKENS,
  DEFAULT_TOOL_PLAN_SYSTEM_PROMPT,
  DEFAULT_TOOL_PLAN_TEMPERATURE,
} from "./services/llm-defaults.js";

const appHome = process.env.NEKODESK_HOME || path.join(process.cwd(), ".nekodesk");

loadEnvFiles([
  path.join(process.cwd(), ".env"),
  path.join(process.cwd(), "backend", ".env")
]);

export function loadConfig() {
  return {
    appHome,
    dbPath: process.env.NEKODESK_DB_PATH || path.join(appHome, "nekodesk.sqlite"),
    githubToken: process.env.GITHUB_TOKEN || "",
    githubApiBaseUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    llm: {
      baseUrl: trimTrailingSlash(process.env.NEKODESK_LLM_URL || "http://127.0.0.1:8803"),
      apiPath: process.env.NEKODESK_LLM_API_PATH || DEFAULT_LLM_API_PATH,
      model: process.env.NEKODESK_LLM_MODEL || "Qwen3 8B Q4_K_M",
      timeoutMs: Number(process.env.NEKODESK_LLM_TIMEOUT_MS || 12000),
      historyLimit: parseNumber(process.env.NEKODESK_LLM_HISTORY_LIMIT, DEFAULT_HISTORY_LIMIT),
      chatTemperature: parseNumber(
        process.env.NEKODESK_LLM_CHAT_TEMPERATURE,
        DEFAULT_CHAT_TEMPERATURE
      ),
      intentTemperature: parseNumber(
        process.env.NEKODESK_LLM_INTENT_TEMPERATURE,
        DEFAULT_INTENT_TEMPERATURE
      ),
      intentMaxTokens: parseNumber(
        process.env.NEKODESK_LLM_INTENT_MAX_TOKENS,
        DEFAULT_INTENT_MAX_TOKENS
      ),
      toolPlanTemperature: parseNumber(
        process.env.NEKODESK_LLM_TOOL_PLAN_TEMPERATURE,
        DEFAULT_TOOL_PLAN_TEMPERATURE
      ),
      toolPlanMaxTokens: parseNumber(
        process.env.NEKODESK_LLM_TOOL_PLAN_MAX_TOKENS,
        DEFAULT_TOOL_PLAN_MAX_TOKENS
      ),
      maxTokens: parseOptionalNumber(process.env.NEKODESK_LLM_MAX_TOKENS),
      headers: safeParseJson(process.env.NEKODESK_LLM_HEADERS_JSON, {}),
      requestBody: safeParseJson(process.env.NEKODESK_LLM_BODY_JSON, {}),
      chatSystemPrompt: readTextOverride(
        "NEKODESK_LLM_CHAT_SYSTEM_PROMPT",
        "NEKODESK_LLM_CHAT_SYSTEM_PROMPT_FILE",
        DEFAULT_CHAT_SYSTEM_PROMPT
      ),
      githubQuerySystemPrompt: readTextOverride(
        "NEKODESK_LLM_GITHUB_QUERY_SYSTEM_PROMPT",
        "NEKODESK_LLM_GITHUB_QUERY_SYSTEM_PROMPT_FILE",
        DEFAULT_GITHUB_QUERY_SYSTEM_PROMPT
      ),
      intentSystemPrompt: readTextOverride(
        "NEKODESK_LLM_INTENT_SYSTEM_PROMPT",
        "NEKODESK_LLM_INTENT_SYSTEM_PROMPT_FILE",
        DEFAULT_INTENT_SYSTEM_PROMPT
      ),
      toolPlanSystemPrompt: readTextOverride(
        "NEKODESK_LLM_TOOL_PLAN_SYSTEM_PROMPT",
        "NEKODESK_LLM_TOOL_PLAN_SYSTEM_PROMPT_FILE",
        DEFAULT_TOOL_PLAN_SYSTEM_PROMPT
      ),
      narrateActionReplies: parseBoolean(
        process.env.NEKODESK_LLM_NARRATE_ACTION_REPLIES,
        true
      ),
      fallbackReply:
        process.env.NEKODESK_LLM_FALLBACK_REPLY || DEFAULT_CHAT_FALLBACK_REPLY,
      connectionErrorReply:
        process.env.NEKODESK_LLM_CONNECTION_ERROR_REPLY || DEFAULT_CONNECTION_ERROR_REPLY
    }
  };
}

function loadEnvFiles(filePaths) {
  for (const filePath of filePaths) {
    if (!fs.existsSync(filePath)) {
      continue;
    }

    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex === -1) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) {
        continue;
      }

      const rawValue = trimmed.slice(separatorIndex + 1).trim();
      process.env[key] = stripQuotes(rawValue);
    }
  }
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function readTextOverride(valueKey, fileKey, fallback) {
  const filePath = process.env[fileKey];
  if (filePath) {
    const resolved = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (fs.existsSync(resolved)) {
      return fs.readFileSync(resolved, "utf8").trim() || fallback;
    }
  }

  return process.env[valueKey] || fallback;
}

function safeParseJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) {
    return false;
  }

  return fallback;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

import path from "node:path";

const appHome = process.env.NEKODESK_HOME || path.join(process.cwd(), ".nekodesk");

export function loadConfig() {
  return {
    appHome,
    dbPath: process.env.NEKODESK_DB_PATH || path.join(appHome, "nekodesk.sqlite"),
    githubToken: process.env.GITHUB_TOKEN || "",
    githubApiBaseUrl: process.env.GITHUB_API_URL || "https://api.github.com",
    llm: {
      baseUrl: process.env.NEKODESK_LLM_URL || "http://127.0.0.1:8803",
      model: process.env.NEKODESK_LLM_MODEL || "Qwen3 8B Q4_K_M",
      timeoutMs: Number(process.env.NEKODESK_LLM_TIMEOUT_MS || 12000)
    }
  };
}

import { mcpListTools, mcpCallTool } from "./mcp-client";
import type { McpTool } from "./mcp-client";

export type { McpTool };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  transport: "http-sse" | "stdio";
  enabled: boolean;
}

export interface McpToolEntry {
  serverId: string;
  serverName: string;
  serverUrl: string;
  tool: McpTool;
}

// ── In-memory registry ────────────────────────────────────────────────────────

let _tools: McpToolEntry[] = [];

export function getMcpTools(): McpToolEntry[] {
  return _tools;
}

export function getMcpTool(name: string): McpToolEntry | undefined {
  return _tools.find((t) => t.tool.name === name);
}

export function isMcpTool(name: string): boolean {
  return _tools.some((t) => t.tool.name === name);
}

// ── Loader ────────────────────────────────────────────────────────────────────

/** Load tool lists from all enabled HTTP-SSE MCP servers. */
export async function loadMcpServers(servers: McpServerConfig[]): Promise<void> {
  _tools = [];

  const httpServers = servers.filter(
    (s) => s.enabled && s.transport === "http-sse" && s.url
  );

  await Promise.allSettled(
    httpServers.map(async (server) => {
      try {
        const tools = await mcpListTools(server.url);
        _tools.push(
          ...tools.map((t) => ({
            serverId: server.id,
            serverName: server.name,
            serverUrl: server.url,
            tool: t,
          }))
        );
        console.info(`[MCP] "${server.name}": ${tools.length}개 도구 로드됨`);
      } catch (err) {
        console.warn(`[MCP] "${server.name}" 로드 실패:`, err);
      }
    })
  );
}

// ── Tool execution ────────────────────────────────────────────────────────────

export async function executeMcpTool(
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  const entry = getMcpTool(name);
  if (!entry) throw new Error(`MCP 도구를 찾을 수 없음: ${name}`);
  return mcpCallTool(entry.serverUrl, name, args);
}

// ── localStorage helpers ──────────────────────────────────────────────────────

const MCP_KEY = "nekodesk_mcp_servers";

export function readMcpServerConfigs(): McpServerConfig[] {
  try {
    const raw = localStorage.getItem(MCP_KEY);
    return raw ? (JSON.parse(raw) as McpServerConfig[]) : [];
  } catch {
    return [];
  }
}

/** Load MCP tool lists from localStorage-persisted server configs. */
export async function initMcpFromStorage(): Promise<void> {
  const servers = readMcpServerConfigs();
  await loadMcpServers(servers);
}

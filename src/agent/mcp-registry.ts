import { mcpListTools, mcpCallTool, type McpTarget } from "./mcp-client";
import { mcpApi, settingsApi } from "../api/tauri";
import type { McpTool } from "./mcp-client";

export type { McpTool };

// ── Types ─────────────────────────────────────────────────────────────────────

export interface McpServerConfig {
  id: string;
  name: string;
  url: string;
  /** stdio 서버가 실행할 명령. 예: `npx -y @modelcontextprotocol/server-time` */
  command?: string;
  transport: "http-sse" | "stdio";
  enabled: boolean;
}

export interface McpToolEntry {
  serverId: string;
  serverName: string;
  target: McpTarget;
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

/** 설정에 적힌 전송 방식으로 서버를 가리키는 핸들을 만든다. */
function targetOf(server: McpServerConfig): McpTarget | null {
  if (server.transport === "stdio") {
    return server.command?.trim() ? { transport: "stdio", id: server.id } : null;
  }
  return server.url ? { transport: "http-sse", url: server.url } : null;
}

/**
 * 켜져 있는 MCP 서버들의 툴 목록을 읽어온다.
 *
 * stdio 서버는 먼저 프로세스를 띄운다. 서버 하나가 실패해도 나머지는 살아야 하므로
 * allSettled 로 돌리고, 실패는 경고만 남긴다 — MCP 하나 때문에 앱이 못 뜨면 안 된다.
 */
export async function loadMcpServers(servers: McpServerConfig[]): Promise<void> {
  // 지난번에 띄운 stdio 프로세스를 먼저 정리한다. 안 하면 설정을 저장할 때마다
  // 고아 프로세스가 하나씩 쌓인다.
  await Promise.allSettled(
    _tools
      .filter((t) => t.target.transport === "stdio")
      .map((t) => t.serverId)
      .filter((id, i, arr) => arr.indexOf(id) === i)
      .map((id) => mcpApi.stop(id))
  );
  _tools = [];

  const enabled = servers.filter((s) => s.enabled);

  await Promise.allSettled(
    enabled.map(async (server) => {
      const target = targetOf(server);
      if (!target) return;
      try {
        if (target.transport === "stdio") {
          await mcpApi.start(server.id, server.command!.trim());
        }
        const tools = await mcpListTools(target);
        _tools.push(
          ...tools.map((tool) => ({
            serverId: server.id,
            serverName: server.name,
            target,
            tool,
          }))
        );
        console.info(`[MCP] "${server.name}" (${server.transport}): ${tools.length}개 도구 로드됨`);
      } catch (err) {
        console.warn(`[MCP] "${server.name}" 로드 실패:`, err);
        if (target.transport === "stdio") await mcpApi.stop(server.id).catch(() => {});
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
  return mcpCallTool(entry.target, name, args);
}

// ── 설정 저장 ─────────────────────────────────────────────────────────────────

const MCP_KEY = "nekodesk_mcp_servers";

/**
 * 서버 설정은 SQLite 에 둔다.
 *
 * 예전엔 localStorage 였는데, 나머지 앱 상태는 이미 DB 에 있어서 백업·이전 경로가
 * 둘로 갈렸다. 기존 localStorage 값은 처음 읽을 때 한 번 옮기고 지운다.
 */
export async function readMcpServerConfigs(): Promise<McpServerConfig[]> {
  try {
    const stored = await settingsApi.get(MCP_KEY);
    if (stored) return JSON.parse(stored) as McpServerConfig[];
  } catch {
    /* DB 를 못 읽으면 아래 localStorage 폴백으로 */
  }

  // 마이그레이션: 예전 위치에 있으면 DB 로 옮기고 지운다.
  try {
    const legacy = localStorage.getItem(MCP_KEY);
    if (!legacy) return [];
    const parsed = JSON.parse(legacy) as McpServerConfig[];
    await settingsApi.set(MCP_KEY, legacy);
    localStorage.removeItem(MCP_KEY);
    console.info(`[MCP] 서버 설정 ${parsed.length}개를 DB 로 옮겼어`);
    return parsed;
  } catch {
    return [];
  }
}

export async function writeMcpServerConfigs(servers: McpServerConfig[]): Promise<void> {
  await settingsApi.set(MCP_KEY, JSON.stringify(servers));
}

/** 저장된 설정으로 MCP 툴 목록을 채운다. */
export async function initMcpFromStorage(): Promise<void> {
  await loadMcpServers(await readMcpServerConfigs());
}

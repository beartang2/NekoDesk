import { mcpApi } from "../api/tauri";

// ── MCP SSE transport client ───────────────────────────────────────────────────
// Implements the legacy MCP SSE transport:
//   1. GET <sseUrl>  → establishes SSE connection
//   2. Server sends "endpoint" event with the POST URL (e.g. /messages?session_id=xxx)
//   3. Client POSTs JSON-RPC to that endpoint
//   4. Responses arrive via the SSE stream, matched by request ID

export interface McpTool {
  name: string;
  description: string;
  inputSchema?: {
    type: "object";
    properties?: Record<string, { type: string; description?: string }>;
    required?: string[];
  };
}

interface JsonRpcMsg {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

let _rpcId = 1;

// ── SSE session ───────────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class McpSseSession {
  private es: EventSource | null = null;
  private postUrl: string | null = null;
  private pending = new Map<number, PendingRequest>();

  /** Open SSE connection and wait for the server's "endpoint" event. */
  connect(sseUrl: string, timeoutMs = 8_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.es?.close();
        reject(new Error("SSE 연결 타임아웃"));
      }, timeoutMs);

      const es = new EventSource(sseUrl);
      this.es = es;

      // The server sends an "endpoint" event whose data is the POST URL
      es.addEventListener("endpoint", (e: MessageEvent<string>) => {
        clearTimeout(timer);
        try {
          this.postUrl = new URL(e.data, sseUrl).href;
        } catch {
          this.postUrl = e.data;
        }
        resolve();
      });

      // Incoming JSON-RPC responses arrive as "message" events
      es.addEventListener("message", (e: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(e.data) as JsonRpcMsg;
          if (msg.id != null) {
            const p = this.pending.get(msg.id);
            if (p) {
              this.pending.delete(msg.id);
              clearTimeout(p.timer);
              if (msg.error) p.reject(new Error(msg.error.message));
              else p.resolve(msg.result);
            }
          }
        } catch {
          /* ignore malformed events */
        }
      });

      es.onerror = () => {
        clearTimeout(timer);
        // Only reject during initial connect
        if (!this.postUrl) reject(new Error("SSE 연결 실패"));
      };
    });
  }

  /** Send a JSON-RPC request and await the matching response via SSE. */
  rpc(method: string, params: unknown, timeoutMs = 15_000): Promise<unknown> {
    if (!this.postUrl) return Promise.reject(new Error("SSE 세션 미연결"));

    const id = _rpcId++;
    const responsePromise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC 타임아웃: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    fetch(this.postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }).catch((err: unknown) => {
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    return responsePromise;
  }

  close() {
    this.es?.close();
    this.es = null;
    this.postUrl = null;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("세션 종료"));
    }
    this.pending.clear();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function withSession<T>(
  sseUrl: string,
  fn: (s: McpSseSession) => Promise<T>
): Promise<T> {
  const session = new McpSseSession();
  try {
    await session.connect(sseUrl);
    // MCP requires initialize before any other call
    await session.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "NekoDesk", version: "0.1.0" },
    });
    return await fn(session);
  } finally {
    session.close();
  }
}

// ── Tool call result ──────────────────────────────────────────────────────────

interface ToolCallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** MCP 의 tools/call 응답을 텍스트로 편다. isError 면 던진다. */
export function unwrapToolResult(result: ToolCallResult | null | undefined): string {
  if (result?.isError) {
    throw new Error(result.content?.map((c) => c.text ?? "").join("") || "tool error");
  }
  return result?.content?.map((c) => c.text ?? "").join("\n") ?? "";
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * 서버 하나를 가리키는 핸들.
 *
 * SSE 는 요청마다 세션을 새로 열고 닫는다(서버가 상태를 안 들고 있어도 되게).
 * stdio 는 이미 떠 있는 프로세스에 붙으므로 id 만 있으면 된다.
 */
export type McpTarget =
  | { transport: "http-sse"; url: string }
  | { transport: "stdio"; id: string };

/** List all tools exposed by this MCP server. */
export async function mcpListTools(target: McpTarget): Promise<McpTool[]> {
  if (target.transport === "stdio") {
    const result = (await mcpApi.rpc(target.id, "tools/list", {})) as { tools?: McpTool[] };
    return result?.tools ?? [];
  }
  return withSession(target.url, async (s) => {
    const result = (await s.rpc("tools/list", {})) as { tools?: McpTool[] };
    return result?.tools ?? [];
  });
}

/** Call a tool and return its text output. */
export async function mcpCallTool(
  target: McpTarget,
  name: string,
  args: Record<string, unknown>
): Promise<string> {
  if (target.transport === "stdio") {
    const result = (await mcpApi.rpc(target.id, "tools/call", {
      name,
      arguments: args,
    })) as ToolCallResult;
    return unwrapToolResult(result);
  }
  return withSession(target.url, async (s) =>
    unwrapToolResult(
      (await s.rpc("tools/call", { name, arguments: args }, 30_000)) as ToolCallResult
    )
  );
}

#!/usr/bin/env python3
"""최소 MCP stdio 서버. 줄 단위 JSON-RPC 로 툴 하나를 노출한다."""
import json, sys

def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

# 배너를 먼저 흘려본다 — 클라이언트가 이걸로 죽으면 안 된다.
sys.stdout.write("fake mcp server booting\n")
sys.stdout.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method, mid = msg.get("method"), msg.get("id")
    if mid is None:
        continue  # notification
    if method == "initialize":
        send({"jsonrpc":"2.0","id":mid,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"fake-server","version":"1.0"},"capabilities":{"tools":{}}}})
    elif method == "tools/list":
        send({"jsonrpc":"2.0","id":mid,"result":{"tools":[{"name":"echo","description":"입력을 그대로 돌려준다","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}}]}})
    elif method == "tools/call":
        name = msg["params"]["name"]
        if name != "echo":
            send({"jsonrpc":"2.0","id":mid,"error":{"code":-32601,"message":f"없는 툴: {name}"}})
        else:
            send({"jsonrpc":"2.0","id":mid,"result":{"content":[{"type":"text","text":msg["params"]["arguments"].get("text","")}]}})
    else:
        send({"jsonrpc":"2.0","id":mid,"error":{"code":-32601,"message":"미지원 메서드"}})

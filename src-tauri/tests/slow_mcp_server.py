#!/usr/bin/env python3
"""tools/call 에 3초 걸리는 MCP stdio 서버.

요청마다 스레드를 띄워 **동시에** 처리한다. 순차 처리하는 서버로 테스트하면
클라이언트가 요청을 겹쳐 보냈는지 아닌지를 구분할 수 없다 — 서버가 만든 지연을
클라이언트 탓으로 오해하게 된다.
"""
import json, sys, threading, time

write_lock = threading.Lock()

def send(obj):
    with write_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()

def handle(msg):
    mid = msg.get("id")
    method = msg.get("method")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "protocolVersion": "2024-11-05",
            "serverInfo": {"name": "slow-server"},
            "capabilities": {"tools": {}},
        }})
    elif method == "tools/call":
        time.sleep(3)
        send({"jsonrpc": "2.0", "id": mid, "result": {
            "content": [{"type": "text", "text": "느린 응답"}]
        }})
    else:
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": []}})

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    if msg.get("id") is None:
        continue  # notification
    threading.Thread(target=handle, args=(msg,), daemon=True).start()

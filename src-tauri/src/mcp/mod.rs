//! MCP stdio 전송.
//!
//! 지금까지는 HTTP(SSE) 서버만 붙일 수 있었다. MCP 생태계의 서버는 대부분 stdio 로
//! 도는 로컬 프로세스라, 사실상 대부분을 못 쓰는 상태였다.
//!
//! 서버 하나당 자식 프로세스 하나를 띄우고 stdin/stdout 으로 줄 단위 JSON-RPC 를
//! 주고받는다. 읽기 전용 스레드가 stdout 을 계속 읽어 id 로 대기 중인 요청에
//! 꽂아준다 — 응답이 요청 순서대로 온다는 보장이 없기 때문이다.

pub mod protocol;

use crate::error::{AppError, AppResult};
use protocol::{build_notification, build_request, parse_line, split_command};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

/// 서버가 이 안에 응답하지 않으면 포기한다. 툴 실행은 오래 걸릴 수 있어 넉넉히.
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
/// 기동(initialize)은 빨라야 한다. 여기서 오래 끌면 설정 화면이 멈춘 것처럼 보인다.
const INIT_TIMEOUT: Duration = Duration::from_secs(15);

static NEXT_ID: AtomicI64 = AtomicI64::new(1);

type Pending = Arc<Mutex<HashMap<i64, mpsc::Sender<Result<Value, String>>>>>;

struct McpProc {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
}

/// 서버 id → 실행 중인 자식 프로세스. 내부 구조는 감춘다.
#[derive(Default)]
pub struct McpRegistry(Mutex<HashMap<String, McpProc>>);

#[derive(Serialize, Debug)]
pub struct McpStartResult {
    /// 서버가 알려준 이름 (있으면).
    pub server_name: Option<String>,
}

impl McpRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

/// 앱이 끝날 때 남은 자식들을 정리한다. 안 하면 고아 프로세스가 계속 산다.
pub fn shutdown_all(registry: &McpRegistry) {
    let Ok(mut map) = registry.0.lock() else { return };
    for (_, mut proc) in map.drain() {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
}

fn send_line(stdin: &mut ChildStdin, line: &str) -> AppResult<()> {
    stdin
        .write_all(line.as_bytes())
        .and_then(|_| stdin.flush())
        .map_err(|e| AppError::msg(format!("MCP 서버에 쓸 수 없어: {e}")))
}

/// stdout 을 계속 읽어 응답을 대기 중인 요청에 꽂는다.
fn spawn_reader(stdout: std::process::ChildStdout, pending: Pending) {
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            let Some(response) = parse_line(&line) else { continue };
            let sender = pending.lock().ok().and_then(|mut p| p.remove(&response.id));
            if let Some(tx) = sender {
                let _ = tx.send(response.outcome);
            }
        }
        // stdout 이 닫혔다 = 서버가 죽었다. 기다리던 요청들을 풀어준다.
        if let Ok(mut p) = pending.lock() {
            for (_, tx) in p.drain() {
                let _ = tx.send(Err("MCP 서버 연결이 끊겼어".to_string()));
            }
        }
    });
}

fn rpc_on(
    stdin: &mut ChildStdin,
    pending: &Pending,
    method: &str,
    params: &Value,
    timeout: Duration,
) -> AppResult<Value> {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    pending
        .lock()
        .map_err(|_| AppError::Lock)?
        .insert(id, tx);

    if let Err(e) = send_line(stdin, &build_request(id, method, params)) {
        pending.lock().ok().map(|mut p| p.remove(&id));
        return Err(e);
    }

    match rx.recv_timeout(timeout) {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(message)) => Err(AppError::msg(message)),
        Err(_) => {
            pending.lock().ok().map(|mut p| p.remove(&id));
            Err(AppError::msg(format!("MCP 응답 시간 초과: {method}")))
        }
    }
}

/// 서버를 띄우고 MCP 핸드셰이크까지 마친다. 같은 id 가 이미 있으면 갈아끼운다.
pub fn start(
    registry: &McpRegistry,
    id: &str,
    command: &str,
    env: &HashMap<String, String>,
) -> AppResult<McpStartResult> {
    let (program, args) = split_command(command)
        .ok_or_else(|| AppError::msg("실행할 명령이 비어 있어"))?;

    stop(registry, id)?;

    let mut child = Command::new(&program)
        .args(&args)
        .envs(env)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        // stderr 는 버린다. 서버들이 여기에 로그를 쏟는데, 파이프를 붙여두고 안 읽으면
        // 버퍼가 차서 서버가 멈춘다.
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AppError::msg(format!("MCP 서버를 실행할 수 없어 ({program}): {e}")))?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::msg("MCP 서버의 stdout 을 열 수 없어"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::msg("MCP 서버의 stdin 을 열 수 없어"))?;

    let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
    spawn_reader(stdout, Arc::clone(&pending));

    let init = rpc_on(
        &mut stdin,
        &pending,
        "initialize",
        &json!({
            "protocolVersion": "2024-11-05",
            "capabilities": { "tools": {} },
            "clientInfo": { "name": "NekoDesk", "version": "0.1.0" },
        }),
        INIT_TIMEOUT,
    );

    let init = match init {
        Ok(v) => v,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(e);
        }
    };

    // 핸드셰이크의 마지막 절차. 이걸 보내야 요청을 받는 서버가 있다.
    send_line(&mut stdin, &build_notification("notifications/initialized", &json!({})))?;

    let server_name = init
        .get("serverInfo")
        .and_then(|s| s.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string);

    registry
        .0
        .lock()
        .map_err(|_| AppError::Lock)?
        .insert(id.to_string(), McpProc { child, stdin, pending });

    Ok(McpStartResult { server_name })
}

pub fn rpc(registry: &McpRegistry, id: &str, method: &str, params: Value) -> AppResult<Value> {
    let mut map = registry.0.lock().map_err(|_| AppError::Lock)?;
    let proc = map
        .get_mut(id)
        .ok_or_else(|| AppError::msg("연결되지 않은 MCP 서버야. 먼저 시작해줘."))?;
    let pending = Arc::clone(&proc.pending);
    rpc_on(&mut proc.stdin, &pending, method, &params, RPC_TIMEOUT)
}

pub fn stop(registry: &McpRegistry, id: &str) -> AppResult<()> {
    let mut map = registry.0.lock().map_err(|_| AppError::Lock)?;
    if let Some(mut proc) = map.remove(id) {
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
    Ok(())
}

pub fn is_running(registry: &McpRegistry, id: &str) -> AppResult<bool> {
    let mut map = registry.0.lock().map_err(|_| AppError::Lock)?;
    let Some(proc) = map.get_mut(id) else { return Ok(false) };
    // try_wait 이 Some 이면 이미 죽었다.
    Ok(matches!(proc.child.try_wait(), Ok(None)))
}

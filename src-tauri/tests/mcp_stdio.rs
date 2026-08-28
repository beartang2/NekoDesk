//! MCP stdio 전송을 실제 자식 프로세스에 붙여 확인한다.
//!
//! 유닛 테스트(`mcp::protocol`)는 프레이밍만 본다. 여기서는 프로세스를 띄우고
//! 핸드셰이크·툴 호출·정리까지 실제로 왕복시킨다 — 파이프 데드락이나 스레드 문제는
//! 진짜 프로세스가 아니면 드러나지 않는다.

use nekodesk_lib::mcp::{self, McpRegistry};
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

/// 테스트용 서버를 실행할 명령. stdout 에 배너를 먼저 흘리도록 만들어져 있다.
fn server_command() -> String {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fake_mcp_server.py");
    format!("python3 {script}")
}

fn start(registry: &McpRegistry, id: &str) {
    mcp::start(registry, id, &server_command(), &HashMap::new())
        .unwrap_or_else(|e| panic!("서버를 띄우지 못했다: {e}"));
}

#[test]
fn handshake_reports_the_server_name_and_ignores_the_banner() {
    let registry = McpRegistry::new();
    let result = mcp::start(&registry, "s1", &server_command(), &HashMap::new()).unwrap();

    // 서버가 stdout 첫 줄에 배너를 흘려도 핸드셰이크가 깨지면 안 된다.
    assert_eq!(result.server_name.as_deref(), Some("fake-server"));
    assert!(mcp::is_running(&registry, "s1").unwrap());

    mcp::stop(&registry, "s1").unwrap();
    assert!(!mcp::is_running(&registry, "s1").unwrap());
}

#[test]
fn lists_and_calls_tools_over_the_pipe() {
    let registry = McpRegistry::new();
    start(&registry, "s2");

    let tools = mcp::rpc(&registry, "s2", "tools/list", json!({})).unwrap();
    assert_eq!(tools["tools"][0]["name"], "echo");

    let called = mcp::rpc(
        &registry,
        "s2",
        "tools/call",
        json!({ "name": "echo", "arguments": { "text": "냐옹" } }),
    )
    .unwrap();
    assert_eq!(called["content"][0]["text"], "냐옹");

    mcp::stop(&registry, "s2").unwrap();
}

#[test]
fn server_errors_surface_as_errors_not_silent_nulls() {
    let registry = McpRegistry::new();
    start(&registry, "s3");

    let err = mcp::rpc(
        &registry,
        "s3",
        "tools/call",
        json!({ "name": "없는툴", "arguments": {} }),
    )
    .unwrap_err()
    .to_string();
    assert!(err.contains("없는 툴"), "{err}");

    mcp::stop(&registry, "s3").unwrap();
}

#[test]
fn calling_an_unstarted_server_is_a_clear_error() {
    let registry = McpRegistry::new();
    let err = mcp::rpc(&registry, "없음", "tools/list", json!({}))
        .unwrap_err()
        .to_string();
    assert!(err.contains("연결되지 않은"), "{err}");
}

#[test]
fn restarting_the_same_id_replaces_the_old_process() {
    let registry = McpRegistry::new();
    start(&registry, "s4");
    start(&registry, "s4"); // 갈아끼우기

    // 갈아끼운 뒤에도 정상 동작해야 한다 (예전 프로세스의 파이프에 붙어 있으면 멈춘다).
    let tools = mcp::rpc(&registry, "s4", "tools/list", json!({})).unwrap();
    assert_eq!(tools["tools"][0]["name"], "echo");

    mcp::stop(&registry, "s4").unwrap();
}

#[test]
fn shutdown_all_kills_every_child() {
    let registry = McpRegistry::new();
    start(&registry, "a");
    start(&registry, "b");

    mcp::shutdown_all(&registry);

    assert!(!mcp::is_running(&registry, "a").unwrap());
    assert!(!mcp::is_running(&registry, "b").unwrap());
}

#[test]
fn a_command_that_does_not_exist_fails_fast_with_the_program_name() {
    let registry = McpRegistry::new();
    let err = mcp::start(&registry, "bad", "이런명령은없다 --flag", &HashMap::new())
        .unwrap_err()
        .to_string();
    assert!(err.contains("이런명령은없다"), "{err}");
}

fn slow_server_command() -> String {
    let script = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/slow_mcp_server.py");
    format!("python3 {script}")
}

#[test]
fn a_slow_server_does_not_block_a_different_one() {
    // 예전에는 rpc() 가 응답을 기다리는 내내 레지스트리 락을 들고 있었다.
    // 그래서 서버 하나의 느린 툴 호출이 다른 모든 서버까지 세웠다.
    let registry = Arc::new(McpRegistry::new());
    mcp::start(&registry, "slow", &slow_server_command(), &HashMap::new()).unwrap();
    start(&registry, "fast");

    let slow_registry = Arc::clone(&registry);
    let slow = std::thread::spawn(move || {
        mcp::rpc(&slow_registry, "slow", "tools/call",
                 json!({ "name": "whatever", "arguments": {} })).unwrap()
    });

    // 느린 호출이 확실히 진행 중일 때 다른 서버를 부른다.
    std::thread::sleep(std::time::Duration::from_millis(400));
    let started = Instant::now();
    let fast = mcp::rpc(&registry, "fast", "tools/list", json!({})).unwrap();
    let waited = started.elapsed();

    assert_eq!(fast["tools"][0]["name"], "echo");
    assert!(
        waited.as_millis() < 1500,
        "느린 서버가 빠른 서버를 {}ms 막았다",
        waited.as_millis()
    );

    slow.join().unwrap();
    mcp::shutdown_all(&registry);
}

#[test]
fn concurrent_calls_to_one_server_overlap_instead_of_queueing() {
    // stdin 을 쓰는 동안만 잠그므로, 클라이언트는 첫 응답을 기다리지 않고 두 번째
    // 요청을 써 보낸다. 서버가 동시에 처리해주면 3초짜리 두 개가 6초가 아니라
    // 3초대에 끝난다. (서버가 순차 처리하면 어차피 6초 — 그건 서버의 성질이다.)
    let registry = Arc::new(McpRegistry::new());
    mcp::start(&registry, "slow", &slow_server_command(), &HashMap::new()).unwrap();

    let started = Instant::now();
    let handles: Vec<_> = (0..2)
        .map(|_| {
            let r = Arc::clone(&registry);
            std::thread::spawn(move || {
                mcp::rpc(&r, "slow", "tools/call", json!({ "name": "x", "arguments": {} }))
            })
        })
        .collect();
    for h in handles {
        h.join().unwrap().unwrap();
    }

    assert!(
        started.elapsed().as_secs() < 5,
        "같은 서버 요청이 겹치지 않고 줄을 섰다: {:?}",
        started.elapsed()
    );
    mcp::shutdown_all(&registry);
}

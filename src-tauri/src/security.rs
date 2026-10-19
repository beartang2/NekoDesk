//! 읽기 전용 보안 점검. 맥의 기본 방어(디스크 암호화·방화벽·SIP·Gatekeeper·자동 보안
//! 업데이트)가 켜져 있는지, 밖에서 들어올 문(원격 로그인·화면 공유)이 열렸는지, 켤 때마다
//! 저절로 도는 항목(LaunchAgents·LaunchDaemons)이 새로 생겼는지 본다.
//!
//! 아무것도 바꾸지 않는다. 모두 관리자 권한 없이 도는 명령이라 묻는 창도 안 뜨고, 다 해서
//! 0.1초 안쪽이다. 하루 첫 브리핑과 `security.check` 도구가 같이 쓴다.
//!
//! 모델에게 셸 명령 여섯 개를 돌려 읽게 하지 않는 건 4B 가 출력 형식을 자주 잘못 읽어서다.
//! 판정은 여기서 하고 모델은 결과를 전하기만 한다.

use rusqlite::Connection;
use serde::Serialize;
use std::net::{SocketAddr, TcpStream};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

use crate::error::AppResult;

#[derive(Serialize, Debug, PartialEq)]
pub struct Check {
    pub ok: bool,
    /// 지금 상태 한 줄. "방화벽 켜짐" / "방화벽 꺼짐".
    pub summary: &'static str,
    /// 괜찮지 않을 때 무엇을 하면 되는지.
    pub advice: &'static str,
}

#[derive(Serialize, Debug)]
pub struct Report {
    pub checks: Vec<Check>,
    /// 켤 때 저절로 도는 항목 전부.
    pub autostart: Vec<String>,
    /// 지난 점검 뒤에 새로 생긴 것. 처음 점검이면 비어 있다(무엇이 새것인지 모른다).
    pub new_autostart: Vec<String>,
}

/// 하나 판정. 명령을 못 돌리면 None — 모르는 걸 "꺼짐" 으로 알리지 않는다.
struct Probe {
    good: &'static str,
    bad: &'static str,
    advice: &'static str,
    run: fn() -> Option<bool>,
}

const PROBES: &[Probe] = &[
    Probe {
        good: "디스크 암호화(FileVault) 켜짐",
        bad: "디스크 암호화(FileVault) 꺼짐",
        advice: "맥을 잃어버리면 디스크를 그대로 읽힌다. 시스템 설정 → 개인정보 보호 및 보안 → FileVault 에서 켜.",
        run: || output("/usr/bin/fdesetup", &["status"]).map(|o| filevault_on(&o)),
    },
    Probe {
        good: "방화벽 켜짐",
        bad: "방화벽 꺼짐",
        advice: "밖에서 들어오는 연결을 막지 않는다. 시스템 설정 → 네트워크 → 방화벽 에서 켜.",
        run: || output("/usr/libexec/ApplicationFirewall/socketfilterfw", &["--getglobalstate"]).map(|o| firewall_on(&o)),
    },
    Probe {
        good: "시스템 무결성 보호(SIP) 켜짐",
        bad: "시스템 무결성 보호(SIP) 꺼짐",
        advice: "시스템 파일을 바꾸는 악성 코드를 못 막는다. 복구 모드에서 csrutil enable 로 켜.",
        run: || output("/usr/bin/csrutil", &["status"]).map(|o| sip_on(&o)),
    },
    Probe {
        good: "Gatekeeper 켜짐",
        bad: "Gatekeeper 꺼짐",
        advice: "서명 안 된 앱도 묻지 않고 열린다. 터미널에서 sudo spctl --master-enable 로 켜.",
        run: || output("/usr/sbin/spctl", &["--status"]).map(|o| gatekeeper_on(&o)),
    },
    Probe {
        good: "보안 업데이트 자동 설치 켜짐",
        bad: "보안 업데이트 자동 설치 꺼짐",
        advice: "급한 보안 패치가 늦게 깔린다. 시스템 설정 → 일반 → 소프트웨어 업데이트 → 자동 업데이트 에서 켜.",
        run: || {
            output("/usr/bin/defaults", &["read", "/Library/Preferences/com.apple.SoftwareUpdate", "CriticalUpdateInstall"])
                .map(|o| auto_update_on(&o))
        },
    },
    Probe {
        good: "원격 로그인(SSH) 닫힘",
        bad: "원격 로그인(SSH) 열림",
        advice: "다른 컴퓨터에서 이 맥에 로그인할 수 있다. 안 쓰면 시스템 설정 → 일반 → 공유 → 원격 로그인 을 꺼.",
        run: || Some(!listening(22)),
    },
    Probe {
        good: "화면 공유 닫힘",
        bad: "화면 공유 열림",
        advice: "다른 컴퓨터에서 이 화면을 보고 조작할 수 있다. 안 쓰면 시스템 설정 → 일반 → 공유 → 화면 공유 를 꺼.",
        run: || Some(!listening(5900)),
    },
];

pub fn checks() -> Vec<Check> {
    PROBES
        .iter()
        .filter_map(|p| {
            (p.run)().map(|ok| Check { ok, summary: if ok { p.good } else { p.bad }, advice: p.advice })
        })
        .collect()
}

fn output(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn filevault_on(out: &str) -> bool {
    out.contains("FileVault is On")
}

/// "Firewall is enabled. (State = 1)". 2 는 꼭 필요한 연결만 받는 더 엄격한 모드라 켜짐이다.
fn firewall_on(out: &str) -> bool {
    match out.split("State = ").nth(1).and_then(|s| s.chars().next()) {
        Some(state) => state != '0',
        None => out.contains("enabled"),
    }
}

fn sip_on(out: &str) -> bool {
    out.contains("status: enabled")
}

fn gatekeeper_on(out: &str) -> bool {
    out.contains("assessments enabled")
}

/// 값이 없으면(defaults 가 아무것도 안 찍으면) macOS 기본값인 켜짐이다. 0 만 꺼짐.
fn auto_update_on(out: &str) -> bool {
    out.trim() != "0"
}

fn listening(port: u16) -> bool {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// 켤 때 저절로 도는 항목. 사용자 폴더는 `~` 로 줄여 적는다.
pub fn autostart() -> Vec<String> {
    let home = dirs::home_dir().unwrap_or_default();
    let mut found = Vec::new();
    for (dir, shown) in [
        (home.join("Library/LaunchAgents"), "~/Library/LaunchAgents"),
        (Path::new("/Library/LaunchAgents").to_path_buf(), "/Library/LaunchAgents"),
        (Path::new("/Library/LaunchDaemons").to_path_buf(), "/Library/LaunchDaemons"),
    ] {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.ends_with(".plist") {
                found.push(format!("{shown}/{name}"));
            }
        }
    }
    found.sort();
    found
}

const AUTOSTART_KEY: &str = "security_autostart";

/// 지난 점검과 견줘 새로 생긴 자동 실행 항목을 돌려주고, 지금 목록을 기억해 둔다.
/// 그래서 새 항목은 한 번만 알린다.
pub fn new_autostart(conn: &Connection, now: &[String]) -> AppResult<Vec<String>> {
    let before = crate::db::settings::get(conn, AUTOSTART_KEY)?;
    crate::db::settings::set(conn, AUTOSTART_KEY, &now.join("\n"))?;
    Ok(added(before.as_deref(), now))
}

fn added(before: Option<&str>, now: &[String]) -> Vec<String> {
    let Some(before) = before else { return Vec::new() };
    let before: Vec<&str> = before.lines().collect();
    now.iter().filter(|n| !before.contains(&n.as_str())).cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_each_tools_wording() {
        assert!(filevault_on("FileVault is On.\n"));
        assert!(!filevault_on("FileVault is Off.\n"));
        assert!(firewall_on("Firewall is enabled. (State = 1)"));
        assert!(firewall_on("Firewall is set to block all non-essential incoming connections. (State = 2)"));
        assert!(!firewall_on("Firewall is disabled. (State = 0)"));
        assert!(sip_on("System Integrity Protection status: enabled."));
        assert!(!sip_on("System Integrity Protection status: disabled."));
        assert!(gatekeeper_on("assessments enabled\n"));
        assert!(!gatekeeper_on("assessments disabled\n"));
        assert!(auto_update_on("1\n"));
        assert!(auto_update_on(""));
        assert!(!auto_update_on("0\n"));
    }

    #[test]
    fn new_autostart_items_are_told_once() {
        let c = Connection::open_in_memory().unwrap();
        crate::db::init_schema(&c).unwrap();
        let a = vec!["~/Library/LaunchAgents/a.plist".to_string()];
        let ab = vec![a[0].clone(), "/Library/LaunchDaemons/b.plist".to_string()];
        // 처음엔 무엇이 새것인지 모른다.
        assert!(new_autostart(&c, &a).unwrap().is_empty());
        assert_eq!(new_autostart(&c, &ab).unwrap(), vec!["/Library/LaunchDaemons/b.plist"]);
        assert!(new_autostart(&c, &ab).unwrap().is_empty());
        // 지운 건 알리지 않는다.
        assert!(new_autostart(&c, &a).unwrap().is_empty());
    }

    /// 이 맥에서 실제로 돌려 본다. 명령이 없거나 출력이 바뀌면 판정이 빠진다.
    #[test]
    #[cfg(target_os = "macos")]
    fn every_probe_runs_on_this_mac() {
        assert_eq!(checks().len(), PROBES.len());
    }
}

//! 열린 포트를 쓰는 프로세스와, CPU·메모리를 많이 쓰는 프로세스. 읽기만 한다.
//!
//! "3000 포트 누가 써?", "맥이 왜 이렇게 느려?" 에 답하려고 모델이 lsof·ps 를 돌려 표를 읽으면 4B 는
//! 열을 자주 헷갈렸다. 여기서 갈라 이름 붙인 값으로 넘긴다. 끝내기는 code.exec(kill) 로 — 확인 창을
//! 거친다.
//!
//! 관리자 권한 없이 돌아서 다른 사용자(시스템)의 프로세스가 연 포트는 안 보인다.

use serde::Serialize;
use std::collections::HashMap;
use std::process::Command;

#[derive(Serialize, Debug, PartialEq)]
pub struct Listener {
    pub port: u16,
    pub pid: u32,
    pub name: String,
    /// 실행한 명령 줄(잘라서). `node` 만으로는 무슨 서버인지 모른다.
    pub command: String,
    /// 밖(같은 네트워크의 다른 기기)에서도 들어올 수 있는가. 127.0.0.1 에만 열렸으면 false.
    pub public: bool,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub name: String,
    pub user: String,
    pub cpu: f32,
    pub mem_mb: u64,
}

#[derive(Serialize, Debug)]
pub struct Snapshot {
    pub listeners: Vec<Listener>,
    pub by_cpu: Vec<Proc>,
    pub by_memory: Vec<Proc>,
}

/// 많이 쓰는 프로세스를 몇 개까지.
const TOP: usize = 5;
const MAX_COMMAND: usize = 120;

pub fn snapshot(port: Option<u16>) -> Snapshot {
    let mut listeners = run("/usr/sbin/lsof", &["-nP", "-iTCP", "-sTCP:LISTEN", "-FpcLn"])
        .map(|o| parse_lsof(&o))
        .unwrap_or_default();
    if let Some(port) = port {
        listeners.retain(|l| l.port == port);
    }
    let pids: Vec<String> = listeners.iter().map(|l| l.pid.to_string()).collect();
    if !pids.is_empty() {
        let args = run("/bin/ps", &["-o", "pid=,args=", "-p", &pids.join(",")]).map(|o| parse_args(&o)).unwrap_or_default();
        for l in &mut listeners {
            if let Some(a) = args.get(&l.pid) {
                l.command = a.chars().take(MAX_COMMAND).collect();
            }
        }
    }
    let ps = |sort: &str| {
        run("/bin/ps", &["-Ao", "pid=,pcpu=,rss=,user=,comm=", sort]).map(|o| parse_ps(&o, TOP)).unwrap_or_default()
    };
    Snapshot { listeners, by_cpu: ps("-r"), by_memory: ps("-m") }
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(program).args(args).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// `lsof -F pcLn` 출력: 프로세스마다 p(pid)·c(이름)·L(사용자) 줄 뒤에 소켓마다 n(주소:포트).
/// IPv4·IPv6 로 같은 포트가 두 번 나오면 하나로 — 한쪽이라도 밖에 열렸으면 밖에 열린 것.
fn parse_lsof(out: &str) -> Vec<Listener> {
    let mut found: Vec<Listener> = Vec::new();
    let (mut pid, mut name) = (0u32, String::new());
    for line in out.lines() {
        let (tag, value) = line.split_at(line.len().min(1));
        match tag {
            "p" => pid = value.parse().unwrap_or(0),
            "c" => name = value.to_string(),
            "n" => {
                let Some((host, port)) = value.rsplit_once(':') else { continue };
                let Ok(port) = port.parse::<u16>() else { continue };
                let public = !matches!(host, "127.0.0.1" | "[::1]" | "localhost");
                match found.iter_mut().find(|l| l.pid == pid && l.port == port) {
                    Some(l) => l.public |= public,
                    None => found.push(Listener { port, pid, name: name.clone(), command: name.clone(), public }),
                }
            }
            _ => {}
        }
    }
    found.sort_by_key(|l| (l.port, l.pid));
    found
}

/// `ps -o pid=,args=` → pid 별 명령 줄.
fn parse_args(out: &str) -> HashMap<u32, String> {
    out.lines()
        .filter_map(|line| {
            let (pid, args) = line.trim_start().split_once(' ')?;
            Some((pid.parse().ok()?, args.trim().to_string()))
        })
        .collect()
}

/// `ps -Ao pid=,pcpu=,rss=,user=,comm=` 의 앞 n 줄. comm 은 경로라 공백이 있을 수 있어 맨 끝에 둔다.
fn parse_ps(out: &str, n: usize) -> Vec<Proc> {
    out.lines()
        .filter_map(|line| {
            let mut cols = line.split_whitespace();
            let pid = cols.next()?.parse().ok()?;
            let cpu = cols.next()?.parse().ok()?;
            let rss_kb: u64 = cols.next()?.parse().ok()?;
            let user = cols.next()?.to_string();
            let path = cols.collect::<Vec<_>>().join(" ");
            let name = path.rsplit('/').next().unwrap_or(&path).to_string();
            Some(Proc { pid, name, user, cpu, mem_mb: rss_kb / 1024 })
        })
        .take(n)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_lsof_fields_and_merges_ipv4_ipv6() {
        let out = "p991\ncrapportd\nLkdh\nf13\nn*:53603\nf14\nn*:53603\np2000\ncnode\nLkdh\nf3\nn127.0.0.1:3000\nf4\nn[::1]:3000\np2001\ncllama-server\nLkdh\nf5\nn127.0.0.1:8803\nf6\nn*:8803\n";
        let found = parse_lsof(out);
        assert_eq!(found.len(), 3);
        assert_eq!((found[0].port, found[0].name.as_str(), found[0].public), (3000, "node", false));
        assert_eq!((found[1].port, found[1].public), (8803, true));
        assert_eq!((found[2].port, found[2].pid), (53603, 991));
    }

    #[test]
    fn reads_ps_with_spaces_in_paths() {
        let out = "  123  45.5 204800 kdh  /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n 7 0.0 1024 root /sbin/launchd\n";
        let top = parse_ps(out, 5);
        assert_eq!(top[0], Proc { pid: 123, name: "Google Chrome".into(), user: "kdh".into(), cpu: 45.5, mem_mb: 200 });
        assert_eq!(top[1].name, "launchd");
        assert_eq!(parse_args(" 2000 node vite --port 3000\n").get(&2000).map(String::as_str), Some("node vite --port 3000"));
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn runs_on_this_mac() {
        let s = snapshot(None);
        assert_eq!(s.by_cpu.len(), TOP);
        assert_eq!(s.by_memory.len(), TOP);
    }
}

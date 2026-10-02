//! llama-server 자식 프로세스 관리.
//!
//! 모델 목록 조회, 실행, 종료, 생존 확인. 커맨드 계층은 여기 함수를 부르기만 한다.
//! 예전에는 이 200줄이 lib.rs 의 커맨드 모듈 안에 그대로 있었다.

use crate::error::{AppError, AppResult};
use crate::{LlamaProc, LlamaServerState};
use serde::{Deserialize, Serialize};
use std::process::{Command, Stdio};
use std::thread;
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize)]
pub struct LlamaConfig {
    pub model: String,
    pub mmproj: Option<String>,
    pub model_draft: Option<String>,
    pub ngl: i32,
    pub flash_attn: bool,
    pub jinja: bool,
    pub ctk: String,
    pub ctv: String,
    pub context: i32,
    pub temp: f32,
    pub top_k: i32,
    pub top_p: f32,
    pub min_p: f32,
    pub port: i32,
    pub host: String,
    pub reasoning: String,
    pub reasoning_format: String,
    pub mtp_n_draft: Option<i32>,
    /// 생각 토큰 상한. -1(또는 없음)이면 제한 없음, 0 이면 바로 끝, N 이면 N 토큰에서 끊는다.
    pub reasoning_budget: Option<i32>,
}

pub fn scan_models() -> AppResult<Vec<String>> {
    let home = dirs::home_dir().ok_or_else(|| AppError::msg("홈 디렉토리를 찾을 수 없습니다"))?;
    let mut files = vec![];

    // ~/models (flat)
    let models_dir = home.join("models");
    if models_dir.exists() {
        if let Ok(entries) = std::fs::read_dir(&models_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("gguf") {
                    files.push(path.to_string_lossy().to_string());
                }
            }
        }
    }

    files.sort();
    Ok(files)
}

pub fn start(
    config: LlamaConfig,
    state: &LlamaServerState,
) -> AppResult<()> {
    // 락을 함수 전체에 걸쳐 잡는다.
    //
    // 예전에는 여기서 잠깐 잡았다 놓고, 1초쯤 걸리는 정리·spawn 을 한 뒤 다시
    // 잡아 저장했다. 커맨드가 메인 스레드에서 하나씩 돌 때는 그 틈에 아무도
    // 끼어들 수 없었지만, 워커로 옮긴 지금은 두 번의 실행 요청이 겹치면 서버가
    // 둘 뜨고 하나는 추적을 잃은 고아로 남는다(GPU 메모리를 문 채로).
    // 잡고 있는 동안 llama_is_running 이 잠깐 막히지만, 그건 워커에서 기다린다.
    let mut guard = state.0.lock().map_err(|e| AppError::msg(e.to_string()))?;

    // 기존 서버 종료: 추적 중인 자식 + 포트를 선점 중인 고아(이전 앱이 SIGKILL 로
    // 죽어 남은 프로세스)까지 청소해야, 포트 충돌로 새 서버가 조용히 즉사하는 것을 막는다.
    if let Some(ref mut child) = guard.child {
        child.kill().ok();
        child.wait().ok();
    }
    *guard = LlamaProc::default();
    crate::kill_port(config.port);

    let home = dirs::home_dir().ok_or_else(|| AppError::msg("홈 디렉토리를 찾을 수 없습니다"))?;
    let models_dir = home.join("models");
    let model_path = if std::path::Path::new(&config.model).is_absolute() {
        std::path::PathBuf::from(&config.model)
    } else {
        models_dir.join(&config.model)
    };

    // llama-server 바이너리 찾기 (brew 경로 포함)
    let binary = ["llama-server", "/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"]
        .iter()
        .find(|&&b| Command::new(b).arg("--version").output().is_ok())
        .map(|&b| b.to_string())
        .ok_or_else(|| AppError::msg("llama-server 바이너리를 찾을 수 없습니다. PATH나 Homebrew 설치를 확인해주세요."))?;

    let mut args: Vec<String> = vec![
        "--model".to_string(), model_path.to_string_lossy().to_string(),
        "-ngl".to_string(), config.ngl.to_string(),
        "-c".to_string(), config.context.to_string(),
        "--port".to_string(), config.port.to_string(),
        "--host".to_string(), config.host.clone(),
        "--temp".to_string(), config.temp.to_string(),
        "--top-k".to_string(), config.top_k.to_string(),
        "--top-p".to_string(), config.top_p.to_string(),
        "--min-p".to_string(), config.min_p.to_string(),
        "-ctk".to_string(), config.ctk.clone(),
        "-ctv".to_string(), config.ctv.clone(),
        "--reasoning".to_string(), config.reasoning.clone(),
        "--reasoning-format".to_string(), config.reasoning_format.clone(),
    ];

    if config.flash_attn {
        args.push("-fa".to_string());
        args.push("on".to_string());
    }
    if config.jinja {
        args.push("--jinja".to_string());
    }
    if let Some(n) = config.reasoning_budget.filter(|n| *n >= 0) {
        args.push("--reasoning-budget".to_string());
        args.push(n.to_string());
    }
    if let Some(n) = config.mtp_n_draft {
        if n > 0 {
            args.push("--spec-type".to_string());
            args.push("draft-mtp".to_string());
            args.push("--spec-draft-n-max".to_string());
            args.push(n.to_string());
        }
    }

    if let Some(draft) = &config.model_draft {
        if !draft.is_empty() {
            let draft_path = if std::path::Path::new(draft).is_absolute() {
                std::path::PathBuf::from(draft)
            } else {
                models_dir.join(draft)
            };
            if !draft_path.exists() {
                return Err(AppError::msg(format!("MTP 드래프트 모델 파일을 찾을 수 없습니다: {}\n설정에서 MTP 모델을 '없음'으로 변경해주세요.", draft)));
            }
            args.push("--model-draft".to_string());
            args.push(draft_path.to_string_lossy().to_string());
        }
    }

    if let Some(mmproj) = &config.mmproj {
        if !mmproj.is_empty() {
            let mmproj_path = if std::path::Path::new(mmproj).is_absolute() {
                std::path::PathBuf::from(mmproj)
            } else {
                models_dir.join(mmproj)
            };
            if !mmproj_path.exists() {
                return Err(AppError::msg(format!("mmproj 파일을 찾을 수 없습니다: {}\n설정에서 mmproj를 '없음'으로 변경해주세요.", mmproj)));
            }
            args.push("--mmproj".to_string());
            args.push(mmproj_path.to_string_lossy().to_string());
        }
    }

    let log_path = std::env::temp_dir().join("nekodesk_llama.log");
    let log_file = std::fs::File::create(&log_path)
        .map_err(|e| AppError::msg(format!("로그 파일 생성 실패: {}", e)))?;

    let mut child = Command::new(&binary)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(log_file)
        .spawn()
        .map_err(|e| AppError::msg(format!("서버 시작 실패: {}", e)))?;

    // 800ms 후 즉시 종료 여부 확인
    thread::sleep(Duration::from_millis(800));
    if let Ok(Some(status)) = child.try_wait() {
        let log = std::fs::read_to_string(&log_path).unwrap_or_default();
        let excerpt: String = log.lines().rev().take(10).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        return Err(AppError::msg(format!("서버가 즉시 종료됨 (exit {})\n{}", status.code().unwrap_or(-1), excerpt)));
    }

    *guard = LlamaProc { child: Some(child), port: Some(config.port) };
    Ok(())
}

pub fn stop(port: i32, state: &LlamaServerState) -> AppResult<()> {
    {
        let mut guard = state.0.lock().map_err(|e| AppError::msg(e.to_string()))?;
        if let Some(ref mut child) = guard.child {
            child.kill().ok();
            child.wait().ok();
        }
        *guard = LlamaProc::default();
    }
    // child handle이 없어도(고아·stale) 해당 포트를 점유 중인 프로세스 강제 종료
    crate::kill_port(port);
    Ok(())
}

pub fn is_running(state: &LlamaServerState) -> AppResult<bool> {
    let mut guard = state.0.lock().map_err(|e| AppError::msg(e.to_string()))?;
    if let Some(ref mut child) = guard.child {
        match child.try_wait() {
            Ok(None) => Ok(true),   // 아직 실행 중
            _ => {
                *guard = LlamaProc::default();
                Ok(false)
            }
        }
    } else {
        Ok(false)
    }
}

use serde::{Serialize, Serializer};

/// 앱 전역 에러 타입.
///
/// 커맨드마다 `Result<_, String>` 을 쓰고 `.map_err(|e| e.to_string())` 를
/// 반복하던 것을 대체한다. `?` 로 자동 변환되고, 커맨드 경계에서는 Display
/// 문자열로 직렬화돼 프런트엔드는 지금과 똑같은 문자열 에러를 받는다.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("데이터베이스 오류: {0}")]
    Db(#[from] rusqlite::Error),

    #[error("네트워크 오류: {0}")]
    Http(#[from] reqwest::Error),

    #[error("내부 상태 잠금 실패")]
    Lock,

    #[error("{0}")]
    Message(String),
}

impl AppError {
    pub fn msg(s: impl Into<String>) -> Self {
        AppError::Message(s.into())
    }
}

/// Mutex 잠금 실패(PoisonError)는 제네릭이라 #[from] 을 못 쓴다. 수동 변환.
impl<T> From<std::sync::PoisonError<T>> for AppError {
    fn from(_: std::sync::PoisonError<T>) -> Self {
        AppError::Lock
    }
}

/// Tauri 커맨드의 Err 타입은 Serialize 여야 한다. 사람이 읽는 메시지로 직렬화.
impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

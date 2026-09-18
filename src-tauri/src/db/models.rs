//! DB 행 ↔ 구조체 매핑.
//!
//! 예전에는 커맨드마다 `Todo { id: row.get(0)?, content: row.get(1)?, ... }` 를
//! 손으로 복붙했다. `TryFrom<&Row>` 한 곳으로 통일한다.
//! 컬럼 인덱스가 아니라 **이름**으로 읽어 SELECT 순서가 바뀌어도 안전하다.

use rusqlite::Row;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Todo {
    pub id: i64,
    pub content: String,
    pub status: String,
    pub priority: Option<i64>,
    pub due_at: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

impl TryFrom<&Row<'_>> for Todo {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> Result<Self, Self::Error> {
        Ok(Todo {
            id: row.get("id")?,
            content: row.get("content")?,
            status: row.get("status")?,
            priority: row.get("priority")?,
            due_at: row.get("due_at")?,
            created_at: row.get("created_at")?,
            completed_at: row.get("completed_at")?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScheduleEvent {
    pub id: i64,
    pub title: String,
    pub start_at: String,
    pub end_at: Option<String>,
    pub notes: Option<String>,
    pub all_day: bool,
    pub created_at: String,
}

impl TryFrom<&Row<'_>> for ScheduleEvent {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> Result<Self, Self::Error> {
        let all_day_int: i64 = row.get("all_day")?;
        Ok(ScheduleEvent {
            id: row.get("id")?,
            title: row.get("title")?,
            start_at: row.get("start_at")?,
            end_at: row.get("end_at")?,
            notes: row.get("notes")?,
            all_day: all_day_int != 0,
            created_at: row.get("created_at")?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ConversationMessage {
    pub id: i64,
    pub session_id: String,
    pub role: String,
    pub content: String,
    pub created_at: String,
    /// 첨부 파일 JSON. 없으면 None.
    pub attachments: Option<String>,
}

impl TryFrom<&Row<'_>> for ConversationMessage {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> Result<Self, Self::Error> {
        Ok(ConversationMessage {
            id: row.get("id")?,
            session_id: row.get("session_id")?,
            role: row.get("role")?,
            content: row.get("content")?,
            created_at: row.get("created_at")?,
            attachments: row.get("attachments")?,
        })
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ExecHistoryItem {
    pub id: i64,
    pub language: String,
    pub code: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
    pub executed_at: String,
}

impl TryFrom<&Row<'_>> for ExecHistoryItem {
    type Error = rusqlite::Error;
    fn try_from(row: &Row<'_>) -> Result<Self, Self::Error> {
        Ok(ExecHistoryItem {
            id: row.get("id")?,
            language: row.get("language")?,
            code: row.get("code")?,
            stdout: row.get("stdout")?,
            stderr: row.get("stderr")?,
            exit_code: row.get("exit_code")?,
            executed_at: row.get("executed_at")?,
        })
    }
}

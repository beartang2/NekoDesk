//! 임시 보관함. 끌어다 놓은 파일을 앱 데이터 폴더의 shelf/ 에 복사해 두고, 지우기
//! 전까지 다시 끌어내(tauri-plugin-drag) 다른 앱이나 채팅에 붙인다.
//!
//! ponytail: 파일을 웹뷰에서 통째로 받아 쓴다(웹뷰 드롭은 경로를 안 준다). 수 GB 짜리면
//! 메모리를 그만큼 쓴다 — 그런 파일을 자주 넣으면 Tauri 드래그 이벤트(경로)로 복사하게 바꾼다.

use crate::error::AppError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

#[derive(Serialize)]
pub struct ShelfItem {
    pub name: String,
    pub path: String,
    pub size: u64,
}

pub fn dir(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let base = app.path().app_data_dir()?;
    // DB 와 같은 규칙: dev 빌드는 따로 둔다.
    let base = if cfg!(debug_assertions) {
        base.parent().unwrap_or(&base).join("nekodesk-dev")
    } else {
        base
    };
    let dir = base.join("shelf");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn list(dir: &Path) -> Result<Vec<ShelfItem>, AppError> {
    let mut entries: Vec<(std::time::SystemTime, ShelfItem)> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.')) // .DS_Store
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, item(&e.path()).ok()?)))
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0)); // 최근에 넣은 것부터
    Ok(entries.into_iter().map(|(_, i)| i).collect())
}

pub fn add(dir: &Path, raw_name: &str, bytes: &[u8]) -> Result<ShelfItem, AppError> {
    let path = free_path(dir, &safe_name(raw_name)?);
    std::fs::write(&path, bytes)?;
    item(&path)
}

pub fn remove(dir: &Path, raw_name: &str) -> Result<(), AppError> {
    std::fs::remove_file(dir.join(safe_name(raw_name)?))?;
    Ok(())
}

/// 헤더엔 ASCII 만 실린다. 프런트가 encodeURIComponent 로 보낸 이름을 되돌린다.
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 3 <= b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 이름 조각만 남긴다. 웹뷰가 준 이름은 믿지 않는다 — "../x" 로 보관함 밖에 쓰거나 지우지 않게.
fn safe_name(raw: &str) -> Result<String, AppError> {
    Path::new(raw.trim())
        .file_name()
        .and_then(|n| n.to_str())
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AppError::msg("파일 이름이 이상해."))
}

/// 같은 이름이 있으면 "이름 (2).확장자" 로 비켜 둔다.
fn free_path(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = p.extension().and_then(|s| s.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .expect("무한 수열에서 빈 이름을 못 찾을 수 없다")
}

fn item(path: &Path) -> Result<ShelfItem, AppError> {
    Ok(ShelfItem {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        size: std::fs::metadata(path)?.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_stay_inside_and_never_overwrite() {
        assert_eq!(percent_decode("%ED%95%9C%20%EA%B8%80.txt"), "한 글.txt");
        assert_eq!(safe_name("../../etc/passwd").unwrap(), "passwd");
        assert!(safe_name("..").is_err());

        let dir = std::env::temp_dir().join(format!("neko-shelf-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        add(&dir, "a.txt", b"1").unwrap();
        assert_eq!(add(&dir, "a.txt", b"2").unwrap().name, "a (2).txt");
        assert_eq!(list(&dir).unwrap().len(), 2);
        remove(&dir, "../a.txt").unwrap(); // 이름만 남아 보관함 안의 a.txt 를 지운다
        assert_eq!(list(&dir).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

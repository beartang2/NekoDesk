//! 임시 보관함. 끌어다 놓은 파일·폴더를 앱 데이터 폴더의 shelf/ 에 복사해 두고, 지우기
//! 전까지 다시 끌어내(tauri-plugin-drag) 다른 앱이나 채팅에 붙인다. 마당 네코가 최근 3개를 입에 문다
//! (docs/neko-screen-mode.md §7).
//!
//! 넣는 길은 둘이다. 앱 보관함(웹뷰 드롭엔 경로가 없다)은 바이트를 받는 `add`, 마당 네코 입은 경로로 바로
//! 복사하는 `add_paths`(폴더도). 바뀌면 부른 쪽(lib.rs)이 `shelf-changed` 를 보낸다.

use crate::error::AppError;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};
use tauri::Manager;

#[derive(Serialize)]
pub struct ShelfItem {
    pub name: String,
    pub path: String,
    /// 폴더면 안의 파일을 다 더한 바이트
    pub size: u64,
    pub dir: bool,
}

/// ponytail: 한 번에 넣는 총량 상한(마당 네코 입). 넘으면 하나도 안 넣는다 — 자주 걸리면 올리거나 설정으로.
pub const MAX_ADD: u64 = 2 << 30;
/// 꺼낸 것(아치에서 끌어내 놓음)을 실제로 지우기까지. 받는 앱(Finder 복사)이 아직 읽는 중일 수 있다.
const TAKE_DELAY: Duration = Duration::from_secs(60);
/// 꺼내서 목록에선 뺐지만 아직 안 지운 것과 꺼낸 때.
static TAKEN: Mutex<Vec<(PathBuf, Instant)>> = Mutex::new(Vec::new());

fn taken(path: &Path) -> bool {
    TAKEN.lock().is_ok_and(|t| t.iter().any(|(p, _)| p == path))
}

/// 도로 넣었다 — 꺼낸 표시를 거둔다(지우지 않는다).
fn untake(path: &Path) {
    if let Ok(mut t) = TAKEN.lock() {
        t.retain(|(p, _)| p != path);
    }
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
    let mut entries: Vec<(SystemTime, ShelfItem)> = std::fs::read_dir(dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file() || t.is_dir()).unwrap_or(false))
        .filter(|e| !e.file_name().to_string_lossy().starts_with('.')) // .DS_Store
        .filter(|e| !taken(&e.path()))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, item(&e.path()).ok()?)))
        .collect();
    entries.sort_by(|a, b| b.0.cmp(&a.0)); // 최근에 넣은 것부터
    Ok(entries.into_iter().map(|(_, i)| i).collect())
}

pub fn add(dir: &Path, raw_name: &str, bytes: &[u8]) -> Result<ShelfItem, AppError> {
    let name = safe_name(raw_name)?;
    // 보관함에서 끌어낸 걸 도로 놓으면 같은 파일이 온다. 이름과 내용이 같으면 그걸 돌려준다.
    // 프런트에서 막으려 했지만 macOS 드래그 끝 알림이 drop 보다 먼저 와서 놓쳤다.
    let same = dir.join(&name);
    let same_len = std::fs::metadata(&same).is_ok_and(|m| m.is_file() && m.len() == bytes.len() as u64);
    if same_len && std::fs::read(&same).is_ok_and(|b| b == bytes) {
        return fresh(&same);
    }
    let path = free_path(dir, &name);
    std::fs::write(&path, bytes)?;
    fresh(&path)
}

/// 경로로 바로 복사한다(마당 네코 입에 놓은 파일·폴더). 넣은 순서대로 돌려준다.
/// 같은 것이면(파일: 이름·내용, 폴더: 이름·파일 수·총 바이트) 있던 것을 맨 앞으로 올린다. 보관함 안의 경로는 복사하지 않는다.
pub fn add_paths(dir: &Path, paths: &[PathBuf]) -> Result<Vec<ShelfItem>, AppError> {
    let home = dir.canonicalize()?;
    let outside: Vec<&PathBuf> = paths.iter().filter(|p| !p.canonicalize().is_ok_and(|c| c.starts_with(&home))).collect();
    let total: u64 = outside.iter().map(|p| tree(p).1).sum();
    if total > MAX_ADD {
        return Err(AppError::msg(format!("한 번에 {}GB 넘게는 못 넣어.", MAX_ADD >> 30)));
    }
    let mut out = Vec::new();
    for p in paths {
        if !outside.contains(&p) {
            out.push(fresh(p)?);
            continue;
        }
        let name = safe_name(&p.to_string_lossy())?;
        let same = dir.join(&name);
        let dest = if p.is_dir() {
            if same.is_dir() && tree(&same) == tree(p) {
                same
            } else {
                let to = free_path(dir, &name);
                copy_tree(p, &to).inspect_err(|_| {
                    let _ = std::fs::remove_dir_all(&to);
                })?;
                to
            }
        } else if same.is_file() && same_content(&same, p)? {
            same
        } else {
            let to = free_path(dir, &name);
            std::fs::copy(p, &to).inspect_err(|_| {
                let _ = std::fs::remove_file(&to);
            })?;
            to
        };
        out.push(fresh(&dest)?);
    }
    Ok(out)
}

pub fn remove(dir: &Path, raw_name: &str) -> Result<(), AppError> {
    let path = dir.join(safe_name(raw_name)?);
    untake(&path);
    remove_path(&path)
}

/// 아치에서 끌어내 놓았다: 목록에서 바로 빼고 TAKE_DELAY 뒤에 지운다. 그 사이 도로 넣으면 남는다.
/// ponytail: 그 전에 앱을 끄면 지우지 못해 다음에 켤 때 목록에 다시 보인다 — 거슬리면 표시를 파일로 남긴다.
pub fn take(dir: &Path, raw_name: &str) -> Result<(), AppError> {
    let path = dir.join(safe_name(raw_name)?);
    if !path.exists() {
        return Err(AppError::msg("보관함에 없는 파일이야."));
    }
    let at = Instant::now();
    TAKEN.lock()?.push((path.clone(), at));
    std::thread::spawn(move || {
        std::thread::sleep(TAKE_DELAY);
        let still = TAKEN.lock().is_ok_and(|mut t| {
            let i = t.iter().position(|(p, when)| *p == path && *when == at);
            i.map(|i| t.remove(i)).is_some()
        });
        if still {
            let _ = remove_path(&path);
        }
    });
    Ok(())
}

fn remove_path(path: &Path) -> Result<(), AppError> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

/// 넣었다(같은 것 포함): 수정 시각을 지금으로 — 목록은 최근 것부터라 방금 넣은 것이 맨 앞이다. 꺼낸 표시도 거둔다.
fn fresh(path: &Path) -> Result<ShelfItem, AppError> {
    let _ = std::fs::File::open(path).and_then(|f| f.set_modified(SystemTime::now()));
    untake(path);
    item(path)
}

/// 폴더 안 (파일 수, 총 바이트). 파일이면 (1, 크기). 심볼릭 링크는 세지 않는다.
fn tree(path: &Path) -> (u64, u64) {
    let Ok(meta) = std::fs::metadata(path) else { return (0, 0) };
    if !meta.is_dir() {
        return (1, meta.len());
    }
    let mut acc = (0, 0);
    for e in std::fs::read_dir(path).into_iter().flatten().flatten() {
        match e.file_type() {
            Ok(t) if t.is_dir() => {
                let (n, b) = tree(&e.path());
                acc = (acc.0 + n, acc.1 + b);
            }
            Ok(t) if t.is_file() => acc = (acc.0 + 1, acc.1 + e.metadata().map(|m| m.len()).unwrap_or(0)),
            _ => {}
        }
    }
    acc
}

/// 폴더를 통째로 복사한다(파일은 fs::copy — APFS 면 복제라 빠르다).
/// ponytail: 심볼릭 링크는 건너뛴다(앱 번들 안 링크가 빠질 수 있다) — 필요하면 링크로 다시 만든다.
fn copy_tree(from: &Path, to: &Path) -> Result<(), AppError> {
    std::fs::create_dir(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let t = e.file_type()?;
        let dest = to.join(e.file_name());
        if t.is_dir() {
            copy_tree(&e.path(), &dest)?;
        } else if t.is_file() {
            std::fs::copy(e.path(), dest)?;
        }
    }
    Ok(())
}

/// 두 파일 내용이 같은가(크기부터 보고 조금씩 읽어 견준다 — 큰 파일을 통째로 올리지 않는다).
fn same_content(a: &Path, b: &Path) -> Result<bool, AppError> {
    use std::io::Read;
    if std::fs::metadata(a)?.len() != std::fs::metadata(b)?.len() {
        return Ok(false);
    }
    let (mut fa, mut fb) = (std::fs::File::open(a)?, std::fs::File::open(b)?);
    let (mut ba, mut bb) = (vec![0u8; 1 << 16], vec![0u8; 1 << 16]);
    loop {
        let n = fa.read(&mut ba)?;
        if n == 0 {
            return Ok(true);
        }
        fb.read_exact(&mut bb[..n])?;
        if ba[..n] != bb[..n] {
            return Ok(false);
        }
    }
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
    let dir = std::fs::metadata(path)?.is_dir();
    Ok(ShelfItem {
        name: path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        size: tree(path).1,
        dir,
    })
}

/// 보관함 안 파일·폴더의 macOS 아이콘(파일 종류 아이콘, 32pt@2x = 64px PNG data URL). 보관함 밖 경로는 받지 않는다.
#[cfg(target_os = "macos")]
pub fn icon(app: &tauri::AppHandle, dir: &Path, path: &str) -> Result<String, AppError> {
    use base64::{engine::general_purpose, Engine as _};
    let p = Path::new(path).canonicalize()?;
    if !p.starts_with(dir.canonicalize()?) {
        return Err(AppError::msg("보관함 밖 파일이야."));
    }
    let p = p.to_string_lossy().into_owned();
    let png = crate::capture::on_main(app, move || unsafe { macos::icon_png(&p) })?.ok_or("아이콘을 못 만들었어.")?;
    Ok(format!("data:image/png;base64,{}", general_purpose::STANDARD.encode(png)))
}

#[cfg(target_os = "macos")]
mod macos {
    use objc2::msg_send;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyClass, AnyObject};
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext, NSImage};
    use objc2_foundation::{NSDictionary, NSPoint, NSRect, NSSize, NSString};

    /// 32pt 아이콘을 2배(64px) 비트맵에 그려 PNG 로. main thread 전용.
    pub unsafe fn icon_png(path: &str) -> Option<Vec<u8>> {
        const PT: f64 = 32.0;
        let ws: *mut AnyObject = msg_send![AnyClass::get(c"NSWorkspace")?, sharedWorkspace];
        let image: Option<Retained<NSImage>> = msg_send![ws, iconForFile: &*NSString::from_str(path)];
        let image = image?;
        let rep = NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            (PT * 2.0) as isize,
            (PT * 2.0) as isize,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            0,
            0,
        )?;
        let size = NSSize::new(PT, PT);
        rep.setSize(size);
        let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep)?;
        NSGraphicsContext::saveGraphicsState_class();
        NSGraphicsContext::setCurrentContext(Some(&ctx));
        image.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), size));
        NSGraphicsContext::restoreGraphicsState_class();
        let data = rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())?;
        Some(data.to_vec())
    }
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
        assert_eq!(add(&dir, "a.txt", b"1").unwrap().name, "a.txt"); // 도로 놓은 같은 파일
        assert_eq!(list(&dir).unwrap().len(), 2);
        remove(&dir, "../a.txt").unwrap(); // 이름만 남아 보관함 안의 a.txt 를 지운다
        assert_eq!(list(&dir).unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn icons_are_64px_pngs_for_files_and_folders() {
        for p in [std::env::temp_dir(), std::env::current_exe().unwrap()] {
            let png = unsafe { macos::icon_png(&p.to_string_lossy()) }.unwrap();
            assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
            assert_eq!(u32::from_be_bytes(png[16..20].try_into().unwrap()), 64); // IHDR 폭
        }
    }

    #[test]
    fn paths_copy_files_and_folders_newest_first_and_reuse_the_same() {
        let root = std::env::temp_dir().join(format!("neko-shelf-paths-{}", std::process::id()));
        let (dir, src) = (root.join("shelf"), root.join("src"));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(src.join("폴더/안")).unwrap();
        std::fs::write(src.join("폴더/a.txt"), b"aa").unwrap();
        std::fs::write(src.join("폴더/안/b.txt"), b"bbb").unwrap();
        std::fs::write(src.join("c.txt"), b"c").unwrap();

        let got = add_paths(&dir, &[src.join("폴더"), src.join("c.txt")]).unwrap();
        assert_eq!(got.iter().map(|i| (i.name.as_str(), i.dir, i.size)).collect::<Vec<_>>(), [("폴더", true, 5), ("c.txt", false, 1)]);
        assert_eq!(std::fs::read(dir.join("폴더/안/b.txt")).unwrap(), b"bbb");
        // 같은 것을 또: 새로 안 만들고 맨 앞으로(수정 시각). 이름만 같은 다른 파일은 따로
        std::thread::sleep(std::time::Duration::from_millis(20));
        add_paths(&dir, &[src.join("폴더")]).unwrap();
        assert_eq!(list(&dir).unwrap().iter().map(|i| i.name.as_str()).collect::<Vec<_>>(), ["폴더", "c.txt"]);
        std::fs::write(src.join("c.txt"), b"d").unwrap();
        assert_eq!(add_paths(&dir, &[src.join("c.txt")]).unwrap()[0].name, "c (2).txt");
        // 보관함 안의 것을 도로 놓으면 복사하지 않는다
        assert_eq!(add_paths(&dir, &[dir.join("c.txt")]).unwrap()[0].path, dir.join("c.txt").to_string_lossy());
        assert_eq!(list(&dir).unwrap().len(), 3);

        // 꺼내면 목록에서 바로 빠지고(파일은 남는다), 도로 넣으면 다시 보인다. 지우기는 폴더째
        take(&dir, "c.txt").unwrap();
        assert!(list(&dir).unwrap().iter().all(|i| i.name != "c.txt") && dir.join("c.txt").exists());
        add_paths(&dir, &[dir.join("c.txt")]).unwrap();
        assert!(list(&dir).unwrap().iter().any(|i| i.name == "c.txt"));
        remove(&dir, "폴더").unwrap();
        assert!(!dir.join("폴더").exists());
        std::fs::remove_dir_all(&root).unwrap();
    }
}

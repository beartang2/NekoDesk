//! AirDrop 으로 파일 보내기.
//!
//! ## 어디까지 되나
//!
//! 받는 사람을 코드로 고르는 공개 API 는 없다 — 그건 의도된 설계다. 할 수 있는 건
//! 파일을 담은 **AirDrop 선택 시트를 여는 것까지**고, 상대를 고르고 보내는 건 사람이
//! 한다. 그래서 이 기능은 "네코가 파일을 보낸다" 가 아니라 "네코가 보낼 준비를
//! 해준다" 다. Finder 를 뒤져 우클릭 → 공유 → AirDrop 하는 손품을 줄여준다.
//!
//! ## 승인은 왜 따로 안 받나
//!
//! 시트가 곧 확인이다. 사람이 상대를 고르지 않으면 아무것도 나가지 않고, 받는 쪽도
//! 수락해야 한다. 확인 다이얼로그를 하나 더 띄우면 같은 걸 두 번 묻는 꼴이다.
//! 다만 **어떤 파일을 담을지**는 모델이 정하므로, 자격증명 경로는 `files::guard` 로
//! 막는다 — 시트에 올라가지도 않는다.

use crate::error::{AppError, AppResult};
use std::path::PathBuf;

/// 한 번에 담을 수 있는 파일 수. 시트에 수백 개를 밀어 넣을 이유가 없다.
const MAX_FILES: usize = 20;

/// 보낼 파일을 확정한다. 경로 정책·존재 여부를 여기서 다 거른다.
///
/// objc 호출과 분리해 둔 이유는 이 부분만 테스트할 수 있게 하려는 것이다.
pub fn resolve_files(paths: &[String]) -> AppResult<Vec<PathBuf>> {
    if paths.is_empty() {
        return Err(AppError::msg("보낼 파일이 없어"));
    }
    if paths.len() > MAX_FILES {
        return Err(AppError::msg(format!(
            "한 번에 {MAX_FILES}개까지만 보낼 수 있어 ({}개를 줬어)",
            paths.len()
        )));
    }

    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
    let mut out = Vec::with_capacity(paths.len());
    for raw in paths {
        let path = crate::files::guard::resolve(raw, &home)
            .map_err(|e| AppError::msg(format!("경로를 확인할 수 없어: {e}")))?;

        // 파일 툴이 못 읽는 건 AirDrop 으로도 못 나간다. 문이 둘이면 자물쇠도 둘이어야 한다.
        if let Some(reason) = crate::files::guard::blocked_reason(&path) {
            return Err(AppError::msg(reason));
        }
        if !path.exists() {
            return Err(AppError::msg(format!("파일이 없어: {}", path.display())));
        }
        if path.is_dir() {
            return Err(AppError::msg(format!(
                "폴더는 AirDrop 으로 못 보내: {}",
                path.display()
            )));
        }
        out.push(path);
    }
    Ok(out)
}

/// AirDrop 선택 시트를 연다. **반드시 메인 스레드에서 호출할 것** (AppKit).
///
/// `NSSharingService` 는 최신 macOS 에서 deprecated 표시가 붙었지만 AirDrop 전송은
/// 그대로 동작한다. 대체재인 `NSSharingServicePicker` 는 띄울 앵커 뷰가 필요한데,
/// 여기서는 띄울 위치가 따로 없어 이쪽이 맞다.
#[cfg(target_os = "macos")]
pub unsafe fn open_share_sheet(files: &[PathBuf]) -> bool {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    let (Some(service_cls), Some(url_cls), Some(str_cls), Some(arr_cls)) = (
        AnyClass::get(c"NSSharingService"),
        AnyClass::get(c"NSURL"),
        AnyClass::get(c"NSString"),
        AnyClass::get(c"NSArray"),
    ) else {
        return false;
    };

    let make_string = |s: &str| -> *mut AnyObject {
        let c = std::ffi::CString::new(s).unwrap_or_default();
        msg_send![str_cls, stringWithUTF8String: c.as_ptr()]
    };

    // NSSharingServiceNameSendViaAirDrop 의 실제 값.
    let name = make_string("com.apple.share.AirDrop.send");
    let service: *mut AnyObject = msg_send![service_cls, sharingServiceNamed: name];
    if service.is_null() {
        return false;
    }

    let urls: Vec<*mut AnyObject> = files
        .iter()
        .map(|p| {
            let s = make_string(&p.to_string_lossy());
            msg_send![url_cls, fileURLWithPath: s]
        })
        .collect();
    let items: *mut AnyObject =
        msg_send![arr_cls, arrayWithObjects: urls.as_ptr(), count: urls.len()];

    let can: bool = msg_send![service, canPerformWithItems: items];
    if !can {
        return false;
    }
    let _: () = msg_send![service, performWithItems: items];
    true
}

/// 시트를 띄우기 직전까지만 가본다 — 클래스 이름·셀렉터·서비스 상수가 맞는지 확인용.
///
/// objc 메시지는 오타가 나도 컴파일이 통과하고 실행할 때 죽는다. 그런데 진짜
/// `performWithItems:` 를 부르면 사람이 닫아야 하는 시트가 뜨므로 테스트에서 쓸 수 없다.
/// 그 직전 단계까지가 오타가 숨을 수 있는 구간 전부다.
#[cfg(all(target_os = "macos", test))]
pub unsafe fn share_sheet_ready(files: &[PathBuf]) -> bool {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};

    let (Some(service_cls), Some(url_cls), Some(str_cls), Some(arr_cls)) = (
        AnyClass::get(c"NSSharingService"),
        AnyClass::get(c"NSURL"),
        AnyClass::get(c"NSString"),
        AnyClass::get(c"NSArray"),
    ) else {
        return false;
    };
    let make_string = |s: &str| -> *mut AnyObject {
        let c = std::ffi::CString::new(s).unwrap_or_default();
        msg_send![str_cls, stringWithUTF8String: c.as_ptr()]
    };
    let name = make_string("com.apple.share.AirDrop.send");
    let service: *mut AnyObject = msg_send![service_cls, sharingServiceNamed: name];
    if service.is_null() {
        return false;
    }
    let urls: Vec<*mut AnyObject> = files
        .iter()
        .map(|p| {
            let s = make_string(&p.to_string_lossy());
            msg_send![url_cls, fileURLWithPath: s]
        })
        .collect();
    let items: *mut AnyObject =
        msg_send![arr_cls, arrayWithObjects: urls.as_ptr(), count: urls.len()];
    msg_send![service, canPerformWithItems: items]
}

#[cfg(not(target_os = "macos"))]
pub unsafe fn open_share_sheet(_files: &[PathBuf]) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("neko_air_{}_{}", std::process::id(), tag));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn resolves_existing_files() {
        let dir = temp("ok");
        let f = dir.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        let got = resolve_files(&[f.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(got.len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_credential_paths_like_the_file_tools_do() {
        // 파일 툴이 못 읽는 걸 AirDrop 으로 내보낼 수 있으면 자물쇠가 한쪽에만 달린 셈이다.
        let dir = temp("secret");
        let f = dir.join(".env");
        std::fs::write(&f, "TOKEN=1").unwrap();
        let err = resolve_files(&[f.to_string_lossy().into_owned()])
            .unwrap_err()
            .to_string();
        assert!(err.contains("민감한"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_missing_files_and_folders() {
        let dir = temp("missing");
        assert!(resolve_files(&[dir.join("없음.txt").to_string_lossy().into_owned()]).is_err());
        assert!(resolve_files(&[dir.to_string_lossy().into_owned()])
            .unwrap_err()
            .to_string()
            .contains("폴더"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn refuses_empty_and_oversized_lists() {
        assert!(resolve_files(&[]).is_err());
        let many: Vec<String> = (0..MAX_FILES + 1).map(|i| format!("/tmp/{i}")).collect();
        assert!(resolve_files(&many).unwrap_err().to_string().contains("20개까지"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_objc_calls_actually_resolve() {
        // 클래스 이름이나 셀렉터에 오타가 있으면 컴파일은 통과하고 실행할 때 죽는다.
        // 시트를 띄우기 직전까지 가보면 그 구간이 전부 검증된다.
        let dir = temp("objc");
        let f = dir.join("a.txt");
        std::fs::write(&f, "x").unwrap();
        assert!(
            unsafe { share_sheet_ready(&[f]) },
            "AirDrop 서비스를 못 찾았거나 파일을 받아주지 않는다"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn one_bad_path_fails_the_whole_batch() {
        // 일부만 보내면 사용자는 무엇이 빠졌는지 모른 채 시트를 보게 된다.
        let dir = temp("mixed");
        let good = dir.join("a.txt");
        std::fs::write(&good, "x").unwrap();
        let err = resolve_files(&[
            good.to_string_lossy().into_owned(),
            dir.join("없음.txt").to_string_lossy().into_owned(),
        ]);
        assert!(err.is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}

//! 날씨용 현재 위치. 위치 서비스(CLLocationManager)에 한 번 묻는다 — 맥·폰 같은 코드(폰은 앱을 쓰는 동안만 권한).
//! 결과는 `"현재 위치 (37.5000,127.0364)"` 꼴 — 설정 칸에 그대로 들어가고, 날씨 쪽
//! (http::weather)이 괄호 안 좌표를 읽어 지오코딩을 건너뛴다.
//!
//! 동네 이름은 붙이지 않는다. 역지오코딩(CLGeocoder)은 macOS 26 에서 deprecated 이고
//! 대체재는 MapKit 의존성이라, 이름 하나 때문에 들이지 않는다.
//!
//! 권한 창의 문구는 src-tauri/Info.plist 에 있다. `tauri dev` 로 띄운 바이너리는 .app
//! 번들이 아니라서 권한이 실행한 터미널·에디터 이름으로 붙을 수 있다.

use crate::error::AppError;
use std::sync::mpsc;
use std::time::Duration;

type Reply = Result<String, String>;

/// 델리게이트가 알려 오는 것. 권한이 있어 위치를 묻기 시작했으면 `Locating`, 끝나면 `Done`.
enum Msg {
    Locating,
    Done(Reply),
}

/// 권한 창을 사용자가 누를 때까지 기다리는 시간.
const PROMPT_WAIT: Duration = Duration::from_secs(60);
/// 권한이 있는데 위치가 안 올 때 기다리는 시간. macOS 는 위치를 못 잡아도 한참 실패를 안 알려,
/// 60초를 다 채우고서야 실패가 떴다. 날씨 앱도 10초면 그만 묻는다.
const FIX_WAIT: Duration = Duration::from_secs(15);

const NO_FIX: &str =
    "위치를 잡지 못했습니다. 잠시 뒤 다시 하거나 날씨 칸에 동네 이름을 직접 적습니다.";

/// 권한이 꺼져 있을 때 켜는 곳
#[cfg(target_os = "ios")]
const SETTINGS_PATH: &str = "설정 앱 › NekoDesk › 위치";
#[cfg(not(target_os = "ios"))]
const SETTINGS_PATH: &str = "시스템 설정 > 개인정보 보호 및 보안 > 위치 서비스";

pub async fn current(app: &tauri::AppHandle) -> Result<String, AppError> {
    let (tx, rx) = mpsc::channel::<Msg>();
    app.run_on_main_thread(move || mac::start(tx))?;
    let got = tauri::async_runtime::spawn_blocking(move || match rx.recv_timeout(PROMPT_WAIT) {
        Ok(Msg::Locating) => match rx.recv_timeout(FIX_WAIT) {
            Ok(Msg::Done(reply)) => Some(reply),
            _ => Some(Err(NO_FIX.into())),
        },
        Ok(Msg::Done(reply)) => Some(reply),
        Err(_) => None,
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?;
    // 끝났으면 묻던 것을 거둔다. 안 그러면 위치를 못 잡은 요청이 뒤에서 계속 돈다.
    let _ = app.run_on_main_thread(mac::stop);
    match got {
        Some(reply) => reply.map_err(AppError::msg),
        None => Err(AppError::msg(format!("위치를 받지 못했습니다. {SETTINGS_PATH}에서 위치 권한을 확인합니다."))),
    }
}

/// 위치 권한 상태(묻지 않는다): "allowed"·"denied"·"ask"(아직 안 물음). 폰 설정의 권한 칸과,
/// 앱이 앞으로 올 때 권한 창 없이 동네를 적을지 볼 때(src/lib/here.ts) 쓴다
pub fn permission() -> &'static str {
    use objc2_core_location::{CLAuthorizationStatus, CLLocationManager};
    let manager = unsafe { CLLocationManager::new() };
    match unsafe { manager.authorizationStatus() } {
        CLAuthorizationStatus::NotDetermined => "ask",
        CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted => "denied",
        _ => "allowed",
    }
}

mod mac {
    use super::{Msg, Reply, SETTINGS_PATH};
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_core_location::{CLAuthorizationStatus, CLLocation, CLLocationManager, CLLocationManagerDelegate};
    use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
    use std::cell::RefCell;
    use std::sync::mpsc::Sender;



    thread_local! {
        // 매니저는 델리게이트를 약하게 잡는다. 응답이 올 때까지 둘 다 여기서 살려 두고,
        // 다음 요청 때 갈아 끼운다(콜백 안에서 자기를 해제하지 않으려고).
        static ACTIVE: RefCell<Option<(Retained<CLLocationManager>, Retained<Delegate>)>> = const { RefCell::new(None) };
    }

    pub struct Ivars {
        tx: RefCell<Option<Sender<Msg>>>,
    }

    define_class!(
        // SAFETY: NSObject 는 서브클래싱 제약이 없고, Delegate 는 Drop 을 구현하지 않는다.
        #[unsafe(super(NSObject))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Ivars]
        pub struct Delegate;

        unsafe impl NSObjectProtocol for Delegate {}

        unsafe impl CLLocationManagerDelegate for Delegate {
            // 델리게이트를 붙이자마자 한 번, 사용자가 권한 창을 누른 뒤 또 한 번 불린다.
            #[unsafe(method(locationManagerDidChangeAuthorization:))]
            fn did_change_authorization(&self, manager: &CLLocationManager) {
                match unsafe { manager.authorizationStatus() } {
                    CLAuthorizationStatus::NotDetermined => unsafe { manager.requestWhenInUseAuthorization() },
                    CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted => {
                        self.finish(Err(format!("위치 권한이 꺼져 있습니다. {SETTINGS_PATH}에서 켤 수 있습니다.")))
                    }
                    _ => {
                        if let Some(tx) = self.ivars().tx.borrow().as_ref() {
                            let _ = tx.send(Msg::Locating);
                        }
                        unsafe { manager.requestLocation() }
                    }
                }
            }

            #[unsafe(method(locationManager:didUpdateLocations:))]
            fn did_update_locations(&self, _manager: &CLLocationManager, locations: &NSArray<CLLocation>) {
                if let Some(location) = locations.lastObject() {
                    let c = unsafe { location.coordinate() };
                    self.finish(Ok(format!("현재 위치 ({:.4},{:.4})", c.latitude, c.longitude)));
                }
            }

            #[unsafe(method(locationManager:didFailWithError:))]
            fn did_fail(&self, _manager: &CLLocationManager, error: &NSError) {
                // 시스템 오류 글은 영어로 올 수 있어 로그에만 남기고, 화면엔 안내 문구를 준다
                log::warn!("위치 실패: {}", error.localizedDescription());
                self.finish(Err(super::NO_FIX.into()));
            }
        }
    );

    impl Delegate {
        fn new(mtm: MainThreadMarker, tx: Sender<Msg>) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars { tx: RefCell::new(Some(tx)) });
            unsafe { msg_send![super(this), init] }
        }

        /// 한 번만 답한다. 권한 변경·위치 갱신이 겹쳐 두 번 와도 뒤의 것은 버린다.
        fn finish(&self, reply: Reply) {
            if let Some(tx) = self.ivars().tx.take() {
                let _ = tx.send(Msg::Done(reply));
            }
        }
    }

    pub fn start(tx: Sender<Msg>) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(Msg::Done(Err("내부 오류: 메인 스레드가 아니야.".into())));
            return;
        };
        let delegate = Delegate::new(mtm, tx);
        let manager = unsafe { CLLocationManager::new() };
        // 날씨엔 동네만 맞으면 되지만 1km 로 두면 locationd 가 절전 경로(#cblsPowerSaver)로 돌려,
        // 지나가다 잡힌 위치만 기다렸다 — 2026-10 macOS 27.2 로그에서 1km 로 묻는 앱(네코·날씨 앱)은
        // 세 시간 동안 위치를 하나도 못 받았고, 100m 로 묻는 시스템 기능은 받았다.
        unsafe {
            manager.setDesiredAccuracy(objc2_core_location::kCLLocationAccuracyHundredMeters);
            manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        }
        ACTIVE.with(|a| *a.borrow_mut() = Some((manager, delegate)));
    }

    /// 묻던 것을 거둔다. 매니저를 놓으면 진행 중인 위치 요청도 멈춘다. main thread 전용.
    pub fn stop() {
        ACTIVE.with(|a| {
            if let Some((manager, _)) = a.borrow_mut().take() {
                unsafe { manager.stopUpdatingLocation() };
            }
        });
    }
}

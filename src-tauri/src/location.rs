//! 날씨용 현재 위치. macOS 위치 서비스(CLLocationManager)에 한 번 묻는다.
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

pub async fn current(app: &tauri::AppHandle) -> Result<String, AppError> {
    let (tx, rx) = mpsc::channel::<Reply>();
    #[cfg(target_os = "macos")]
    app.run_on_main_thread(move || mac::start(tx))?;
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, tx);
        return Err(AppError::msg("현재 위치는 macOS 에서만 쓸 수 있어."));
    }
    // 처음엔 사용자가 권한 창을 누를 때까지 기다린다.
    let got = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(60)))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?;
    match got {
        Ok(reply) => reply.map_err(AppError::msg),
        Err(_) => Err(AppError::msg("위치를 받지 못했어. 시스템 설정 > 개인정보 보호 및 보안 > 위치 서비스를 확인해줘.")),
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::Reply;
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{define_class, msg_send, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_core_location::{CLAuthorizationStatus, CLLocation, CLLocationManager, CLLocationManagerDelegate};
    use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
    use std::cell::RefCell;
    use std::sync::mpsc::Sender;

    const DENIED: &str = "위치 권한이 꺼져 있어. 시스템 설정 > 개인정보 보호 및 보안 > 위치 서비스에서 켜줘.";

    thread_local! {
        // 매니저는 델리게이트를 약하게 잡는다. 응답이 올 때까지 둘 다 여기서 살려 두고,
        // 다음 요청 때 갈아 끼운다(콜백 안에서 자기를 해제하지 않으려고).
        static ACTIVE: RefCell<Option<(Retained<CLLocationManager>, Retained<Delegate>)>> = const { RefCell::new(None) };
    }

    pub struct Ivars {
        tx: RefCell<Option<Sender<Reply>>>,
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
                    CLAuthorizationStatus::Denied | CLAuthorizationStatus::Restricted => self.finish(Err(DENIED.into())),
                    _ => unsafe { manager.requestLocation() },
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
                self.finish(Err(format!("위치를 못 찾았어: {}", error.localizedDescription())));
            }
        }
    );

    impl Delegate {
        fn new(mtm: MainThreadMarker, tx: Sender<Reply>) -> Retained<Self> {
            let this = Self::alloc(mtm).set_ivars(Ivars { tx: RefCell::new(Some(tx)) });
            unsafe { msg_send![super(this), init] }
        }

        /// 한 번만 답한다. 권한 변경·위치 갱신이 겹쳐 두 번 와도 뒤의 것은 버린다.
        fn finish(&self, reply: Reply) {
            if let Some(tx) = self.ivars().tx.take() {
                let _ = tx.send(reply);
            }
        }
    }

    pub fn start(tx: Sender<Reply>) {
        let Some(mtm) = MainThreadMarker::new() else {
            let _ = tx.send(Err("내부 오류: 메인 스레드가 아니야.".into()));
            return;
        };
        let delegate = Delegate::new(mtm, tx);
        let manager = unsafe { CLLocationManager::new() };
        // 날씨엔 동네만 맞으면 된다. 정밀도를 낮추면 더 빨리, 덜 깨워서 온다.
        unsafe {
            manager.setDesiredAccuracy(objc2_core_location::kCLLocationAccuracyKilometer);
            manager.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        }
        ACTIVE.with(|a| *a.borrow_mut() = Some((manager, delegate)));
    }
}

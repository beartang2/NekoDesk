//! 네코 산책 지도. MapKit 으로 지도 그림·근처 장소·걷기 경로를 얻는다(맥·폰 같은 코드 — 그림을 PNG 로 굽고
//! 어두운 지도를 고르는 곳만 다르다).
//! MapKit JS 는 개발자 계정 키가 있어야 해서 키가 필요 없는 네이티브 쪽을 쓴다.
//! 요청은 Apple 지도 서버로 간다.
//!
//! location.rs 와 같은 꼴 — main thread 에서 요청을 시작하고(완료 콜백도 main queue 로 온다),
//! 답은 mpsc 로 받아 spawn_blocking 에서 기다린다.

use crate::error::AppError;
use block2::RcBlock;
use objc2::AllocAnyThread;
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSAppearance, NSAppearanceNameAqua, NSAppearanceNameDarkAqua, NSBitmapImageFileType, NSBitmapImageRep, NSDeviceRGBColorSpace, NSGraphicsContext,
};
use objc2_core_location::CLLocationCoordinate2D;
#[cfg(target_os = "macos")]
use objc2_foundation::{NSDictionary, NSPoint, NSRect};
use objc2_foundation::{NSArray, NSError, NSRange, NSSize, NSString};
use objc2_map_kit::*;
use serde::Serialize;
use std::cell::RefCell;
use std::ptr::NonNull;
use std::rc::Rc;
use std::sync::mpsc::{self, Sender};
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapSnapshot {
    data_url: String,
    meters_per_px: f64,
}

#[derive(Serialize)]
pub struct MapPlace {
    name: String,
    category: String,
    lat: f64,
    lon: f64,
}

type Reply<T> = Result<T, String>;

/// 지도 서버가 이만큼 답이 없으면 그만 기다린다.
const WAIT: Duration = Duration::from_secs(15);

// 실패는 까닭만 로그에 남긴다(배포판은 warn 부터, NekoDesk.log). 좌표는 적지 않는다 — 사용자 자리라서.

#[tauri::command]
pub async fn map_snapshot(app: tauri::AppHandle, lat: f64, lon: f64, span_m: f64, width: f64, height: f64, dark: bool) -> Result<MapSnapshot, AppError> {
    // 세로 거리는 span_m * height / width 라, 길쭉한 그림이면 그쪽도 본다.
    if !(width >= 1.0 && height >= 1.0 && on_map(lat, lon, span_m * (height / width).max(1.0))) {
        return Err(BAD_INPUT.into());
    }
    ask(&app, move |tx| snapshot(lat, lon, span_m, width, height, dark, tx)).await.inspect_err(|e| log::warn!("산책 지도 그림 실패: {e}"))
}

#[tauri::command]
pub async fn map_places(app: tauri::AppHandle, lat: f64, lon: f64, radius_m: f64) -> Result<Vec<MapPlace>, AppError> {
    if !on_map(lat, lon, radius_m * 2.0) {
        return Err(BAD_INPUT.into());
    }
    let found = ask(&app, move |tx| places(lat, lon, radius_m, tx)).await.inspect_err(|e| log::warn!("산책 장소 찾기 실패: {e}"))?;
    if found.is_empty() {
        log::warn!("산책 장소가 근처에 하나도 없어 — 지도 없이 대체 경로로 걷는다");
    }
    Ok(found)
}

#[tauri::command]
pub async fn map_walk_route(app: tauri::AppHandle, from: [f64; 2], to: [f64; 2]) -> Result<Vec<[f64; 2]>, AppError> {
    ask(&app, move |tx| walk_route(from, to, tx)).await.inspect_err(|e| log::warn!("산책 길 찾기 실패: {e}"))
}

const BAD_INPUT: &str = "지도 요청 값이 이상해.";

/// MapKit 은 범위 밖 좌표·0 크기·지나치게 넓은 영역에 ObjC 예외를 던지고, 그 예외는 Rust 를
/// 못 건너 앱이 통째로 죽는다. 그래서 묻기 전에 거른다. 메르카토르 지도는 위도 ±85° 밖을 못 그리고,
/// 산책 지도는 100km 면 넉넉하다. (걷기 경로는 이상한 좌표에도 에러로 답해서 안 거른다.)
fn on_map(lat: f64, lon: f64, span_m: f64) -> bool {
    lat.abs() <= 85.0 && lon.abs() <= 180.0 && span_m > 0.0 && span_m <= 100_000.0
}

/// main thread 에서 `start` 를 부르고, 넘겨준 Sender 로 답이 올 때까지 기다린다.
async fn ask<T: Send + 'static>(app: &tauri::AppHandle, start: impl FnOnce(Sender<Reply<T>>) + Send + 'static) -> Result<T, AppError> {
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || start(tx))?;
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(WAIT))
        .await
        .map_err(|e| AppError::msg(e.to_string()))?
        .map_err(|_| AppError::msg("지도 서버가 답이 없어. 인터넷 연결을 확인해줘."))?
        .map_err(AppError::msg)
}

// ── MapKit. 아래는 모두 main thread 에서 불린다. 시작한 요청(스냅샷·검색·경로)은 MapKit 이
// 끝날 때까지 붙잡고 있어서, location.rs 처럼 따로 살려 두지 않아도 콜백이 온다. ──

fn coord(lat: f64, lon: f64) -> CLLocationCoordinate2D {
    CLLocationCoordinate2D { latitude: lat, longitude: lon }
}

fn failed(what: &str, err: *mut NSError) -> String {
    match unsafe { err.as_ref() } {
        Some(e) => format!("{what}: {}", e.localizedDescription()),
        None => what.into(),
    }
}

fn snapshot(lat: f64, lon: f64, span_m: f64, width: f64, height: f64, dark: bool, tx: Sender<Reply<MapSnapshot>>) {
    unsafe {
        let options = MKMapSnapshotOptions::new();
        // 세로 거리를 크기 비율에 맞춰 줘야 MapKit 이 영역을 한쪽으로 늘려 맞추지 않는다.
        let region = MKCoordinateRegion::with_distance(coord(lat, lon), span_m * height / width, span_m);
        options.setRegion(region);
        options.setSize(NSSize::new(width, height));
        set_dark(&options, dark);
        let half = region.span.longitudeDelta / 2.0;
        let done = RcBlock::new(move |shot: *mut MKMapSnapshot, err: *mut NSError| {
            let reply = match shot.as_ref() {
                Some(shot) => {
                    // 실제로 그려진 축척을 잰다. MapKit 이 영역을 조금 넓혀 맞췄어도 맞는 값이 나온다.
                    let west = shot.pointForCoordinate(coord(lat, lon - half));
                    let east = shot.pointForCoordinate(coord(lat, lon + half));
                    png(shot, width, height).map(|png| MapSnapshot {
                        data_url: format!("data:image/png;base64,{png}"),
                        meters_per_px: span_m / (east.x - west.x),
                    })
                }
                None => Err(failed("지도를 못 그렸어", err)),
            };
            let _ = tx.send(reply);
        });
        MKMapSnapshotter::initWithOptions(MKMapSnapshotter::alloc(), &options).startWithCompletionHandler(RcBlock::as_ptr(&done));
    }
}

#[cfg(target_os = "macos")]
unsafe fn set_dark(options: &MKMapSnapshotOptions, dark: bool) {
    let name = if dark { NSAppearanceNameDarkAqua } else { NSAppearanceNameAqua };
    options.setAppearance(NSAppearance::appearanceNamed(name).as_deref());
}

/// 폰: 어두운 지도는 traitCollection(UIUserInterfaceStyle 1 = 밝게, 2 = 어둡게). 그림 배율은 맥과 같은 2배
#[cfg(target_os = "ios")]
unsafe fn set_dark(options: &MKMapSnapshotOptions, dark: bool) {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let options = options as *const MKMapSnapshotOptions as *mut AnyObject;
    if let Some(cls) = AnyClass::get(c"UITraitCollection") {
        let style: isize = if dark { 2 } else { 1 };
        let traits: *mut AnyObject = msg_send![cls, traitCollectionWithUserInterfaceStyle: style];
        if !traits.is_null() {
            let _: () = msg_send![options, setTraitCollection: traits];
        }
    }
    let _: () = msg_send![options, setScale: 2.0f64];
}

/// 폰: 스냅샷의 UIImage(2배)를 base64 PNG 로(UIImagePNGRepresentation — UIKit 은 앱에 늘 붙어 있다)
#[cfg(target_os = "ios")]
fn png(shot: &MKMapSnapshot, _width: f64, _height: f64) -> Reply<String> {
    use base64::{engine::general_purpose, Engine as _};
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    extern "C" {
        fn UIImagePNGRepresentation(image: *mut AnyObject) -> *mut AnyObject;
    }
    unsafe {
        let image: *mut AnyObject = msg_send![shot as *const MKMapSnapshot as *mut AnyObject, image];
        if image.is_null() {
            return Err("지도 그림이 비었어.".into());
        }
        let data = UIImagePNGRepresentation(image);
        if data.is_null() {
            return Err("지도 그림을 PNG 로 못 바꿨어.".into());
        }
        let len: usize = msg_send![data, length];
        let bytes: *const u8 = msg_send![data, bytes];
        if bytes.is_null() || len == 0 {
            return Err("지도 그림을 PNG 로 못 바꿨어.".into());
        }
        Ok(general_purpose::STANDARD.encode(std::slice::from_raw_parts(bytes, len)))
    }
}

/// 스냅샷 그림을 2배 크기 base64 PNG 로. 스냅샷은 그릴 때마다 렌더하는 NSCustomImageRep 이라
/// TIFFRepresentation 은 1배로 굽고, 기본 변환은 주 화면 배율을 따른다 — 2배 비트맵에 직접 그린다.
#[cfg(target_os = "macos")]
fn png(shot: &MKMapSnapshot, width: f64, height: f64) -> Reply<String> {
    let image = unsafe { shot.image() };
    use base64::{engine::general_purpose, Engine as _};
    let size = NSSize::new(width, height);
    let rep = unsafe {
        NSBitmapImageRep::initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel(
            NSBitmapImageRep::alloc(),
            std::ptr::null_mut(),
            (width * 2.0).round() as isize,
            (height * 2.0).round() as isize,
            8,
            4,
            true,
            false,
            NSDeviceRGBColorSpace,
            0,
            0,
        )
    }
    .ok_or("지도 그림을 담을 자리를 못 만들었어.")?;
    rep.setSize(size);
    let ctx = NSGraphicsContext::graphicsContextWithBitmapImageRep(&rep).ok_or("지도 그림을 담을 자리를 못 만들었어.")?;
    NSGraphicsContext::saveGraphicsState_class();
    NSGraphicsContext::setCurrentContext(Some(&ctx));
    image.drawInRect(NSRect::new(NSPoint::new(0.0, 0.0), size));
    NSGraphicsContext::restoreGraphicsState_class();
    let (w, h) = (rep.pixelsWide().max(0) as usize, rep.pixelsHigh().max(0) as usize);
    let bitmap = rep.bitmapData();
    if !bitmap.is_null() && tiles_missing(unsafe { std::slice::from_raw_parts(bitmap, rep.bytesPerRow() as usize * h) }, w, h, rep.bytesPerRow() as usize) {
        return Err(NO_TILES.into());
    }
    let data = unsafe { rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()) }.ok_or("지도 그림을 PNG 로 못 바꿨어.")?;
    Ok(general_purpose::STANDARD.encode(data.to_vec()))
}

/// 지도 조각을 못 받은 그림(macOS 27.3 베타에서 시스템 지도 서비스가 지도 자원을 못 찾을 때, 2026-11-23). MapKit 은 이걸 성공으로
/// 준다 — 길·글자 없이 모눈 바탕만 있는 그림이다. 실패로 돌려 화면이 대체 그림(동심원·산책 중)을 쓰게 한다
#[cfg(target_os = "macos")]
const NO_TILES: &str = "지도 조각을 못 받아 모눈 바탕만 왔어(시스템 지도 서비스 문제 — 지도 앱도 같은지 확인)";
/// 모눈 바탕은 4비트로 묶어 밝게 18색·어둡게 6색이다. 진짜 지도는 길·글자·장소 아이콘·공원 가장자리로 이보다 훨씬 많다.
/// ponytail: 색 수만 본다 — 바다뿐인 지도처럼 정말 밋밋한 지도도 빈 그림으로 칠 수 있다(그러면 동심원이 보이고 로그에 남는다).
/// 그런 일이 보이면 모눈 줄(한 줄 전체가 같은 색)까지 보게 고친다
#[cfg(target_os = "macos")]
const FEW_COLORS: usize = 24;

/// RGBA 비트맵이 모눈 바탕뿐인가: 4비트로 묶은 색이 FEW_COLORS 보다 적다
#[cfg(target_os = "macos")]
fn tiles_missing(px: &[u8], w: usize, h: usize, stride: usize) -> bool {
    let mut seen = std::collections::HashSet::new();
    for y in 0..h {
        for x in 0..w {
            let i = y * stride + x * 4;
            let Some(p) = px.get(i..i + 3) else { return false };
            seen.insert(((p[0] >> 4) as u16) << 8 | ((p[1] >> 4) as u16) << 4 | (p[2] >> 4) as u16);
            if seen.len() >= FEW_COLORS {
                return false;
            }
        }
    }
    true
}

/// 근처 장소 검색어. MKLocalPointsOfInterestRequest 는 한국에선 거의 비어 온다(시청 앞 2km 에 0곳,
/// 같은 반경 샌프란시스코·도쿄는 40곳 남짓) — 검색어 검색은 한국에서도 잘 나온다.
/// 요청마다 MapKit 의 분당 요청 한도를 이만큼 쓴다.
const PLACE_QUERIES: [&str; 6] = ["park", "cafe", "bakery", "library", "museum", "convenience store"];

fn places(lat: f64, lon: f64, radius_m: f64, tx: Sender<Reply<Vec<MapPlace>>>) {
    unsafe {
        // 고양이가 어슬렁 들를 만한 곳만. 검색어에 딸려 오는 호텔·주유소·병원은 여기서 걸러진다.
        // 새 OS 에만 있는 분류는 null 이라 빠진다.
        let kinds: Vec<&NSString> = [
            MKPointOfInterestCategoryPark,
            MKPointOfInterestCategoryNationalPark,
            MKPointOfInterestCategoryBeach,
            MKPointOfInterestCategoryMarina,
            MKPointOfInterestCategoryCampground,
            MKPointOfInterestCategoryZoo,
            MKPointOfInterestCategoryAquarium,
            MKPointOfInterestCategoryCafe,
            MKPointOfInterestCategoryBakery,
            MKPointOfInterestCategoryFoodMarket,
            MKPointOfInterestCategoryStore,
            MKPointOfInterestCategoryLibrary,
            MKPointOfInterestCategoryMuseum,
            MKPointOfInterestCategoryLandmark,
        ]
        .into_iter()
        .flatten()
        .collect();
        let filter = MKPointOfInterestFilter::initIncludingCategories(MKPointOfInterestFilter::alloc(), &NSArray::from_slice(&kinds));
        let region = MKCoordinateRegion::with_distance(coord(lat, lon), radius_m * 2.0, radius_m * 2.0);
        // 검색어마다 따로 묻고 다 오면 합쳐 한 번 보낸다. 콜백은 모두 main thread 라 Rc 로 된다.
        // (남은 수, 모은 곳, 마지막 에러)
        let acc = Rc::new(RefCell::new((PLACE_QUERIES.len(), Vec::<MapPlace>::new(), None::<String>)));
        for query in PLACE_QUERIES {
            let request = MKLocalSearchRequest::new();
            request.setNaturalLanguageQuery(Some(&NSString::from_str(query)));
            request.setRegion(region);
            request.setResultTypes(MKLocalSearchResultType::PointOfInterest);
            request.setPointOfInterestFilter(Some(&filter));
            let (acc, tx) = (acc.clone(), tx.clone());
            let done = RcBlock::new(move |res: *mut MKLocalSearchResponse, err: *mut NSError| {
                let (left, found, last_err) = &mut *acc.borrow_mut();
                match res.as_ref() {
                    Some(res) => {
                        for item in res.mapItems() {
                            // MKMapItem.location 은 macOS 26 부터라 그 아래에서 죽는다. placemark 로 읽는다.
                            #[allow(deprecated)]
                            let c = item.placemark().coordinate();
                            let name = item.name().map(|n| n.to_string()).unwrap_or_default();
                            // 검색은 영역 밖 결과도 섞어 준다. 반경으로 자르고, 검색어끼리 겹친 곳은 하나만.
                            if distance_m(lat, lon, c.latitude, c.longitude) > radius_m
                                || found.iter().any(|p| p.name == name && p.lat == c.latitude && p.lon == c.longitude)
                            {
                                continue;
                            }
                            found.push(MapPlace {
                                name,
                                category: item.pointOfInterestCategory().map(|n| n.to_string()).unwrap_or_default(),
                                lat: c.latitude,
                                lon: c.longitude,
                            });
                        }
                    }
                    // 근처에 그런 곳이 없으면 MapKit 은 에러로 알린다. 빈 답이 맞다.
                    None if err
                        .as_ref()
                        .is_some_and(|e| e.code() == MKErrorCode::PlacemarkNotFound.0 as isize && *e.domain() == *MKErrorDomain) => {}
                    None => *last_err = Some(failed("근처 장소를 못 찾았어", err)),
                }
                *left -= 1;
                if *left == 0 {
                    let found = std::mem::take(found);
                    let _ = tx.send(match last_err.take() {
                        Some(e) if found.is_empty() => Err(e),
                        _ => Ok(found),
                    });
                }
            });
            MKLocalSearch::initWithRequest(MKLocalSearch::alloc(), &request).startWithCompletionHandler(RcBlock::as_ptr(&done));
        }
    }
}

/// 두 점 사이 거리(m). 산책 반경 몇 km 안이라 평면 근사로 충분하다.
fn distance_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dy = (lat2 - lat1).to_radians();
    let dx = (lon2 - lon1).to_radians() * lat1.to_radians().cos();
    dx.hypot(dy) * 6_371_000.0
}

fn walk_route(from: [f64; 2], to: [f64; 2], tx: Sender<Reply<Vec<[f64; 2]>>>) {
    unsafe {
        // MKMapItem(location:address:) 는 macOS 26 부터라 그 아래에서 죽는다. placemark 로 만든다.
        #[allow(deprecated)]
        let item = |[lat, lon]: [f64; 2]| MKMapItem::initWithPlacemark(MKMapItem::alloc(), &MKPlacemark::initWithCoordinate(MKPlacemark::alloc(), coord(lat, lon)));
        let request = MKDirectionsRequest::new();
        request.setSource(Some(&item(from)));
        request.setDestination(Some(&item(to)));
        request.setTransportType(MKDirectionsTransportType::Walking);
        let done = RcBlock::new(move |res: *mut MKDirectionsResponse, err: *mut NSError| {
            let route = res.as_ref().and_then(|res| res.routes().firstObject());
            let reply = match route {
                Some(route) => {
                    let line = route.polyline();
                    let n = line.pointCount();
                    let mut coords = vec![coord(0.0, 0.0); n];
                    line.getCoordinates_range(NonNull::from(coords.as_mut_slice()).cast(), NSRange::new(0, n));
                    // 경로는 가까운 길 위에서 시작·끝난다. 네코가 장소 바로 앞까지 가도록 양 끝을 잇는다.
                    let mut points = vec![from];
                    points.extend(coords.iter().map(|c| [c.latitude, c.longitude]));
                    points.push(to);
                    points.dedup();
                    Ok(points)
                }
                None => Err(failed("걸어서 갈 길을 못 찾았어", err)),
            };
            let _ = tx.send(reply);
        });
        MKDirections::initWithRequest(MKDirections::alloc(), &request).calculateDirectionsWithCompletionHandler(RcBlock::as_ptr(&done));
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_bare_grid_counts_as_no_map() {
        // 바탕 + 모눈 두 색(지도 조각 없음) → 빈 그림, 색이 고루 섞인 그림 → 지도
        let (w, h) = (64, 64);
        let grid: Vec<u8> = (0..w * h).flat_map(|i| match (i % w % 16, i / w % 16) { (0, _) | (_, 0) => [120, 120, 120, 255], (8, _) | (_, 8) => [220, 215, 210, 255], _ => [246, 243, 238, 255] }).collect();
        assert!(super::tiles_missing(&grid, w, h, w * 4));
        let map: Vec<u8> = (0..w * h).flat_map(|i| [(i * 7 % 256) as u8, (i * 13 % 256) as u8, (i * 29 % 256) as u8, 255]).collect();
        assert!(!super::tiles_missing(&map, w, h, w * 4));
    }

    #[test]
    fn distance_is_meters() {
        // 위도 0.01° ≈ 1112m, 서울 위도에서 경도 0.01° ≈ 882m.
        assert!((super::distance_m(37.5, 127.0, 37.51, 127.0) - 1112.0).abs() < 2.0);
        assert!((super::distance_m(37.5, 127.0, 37.5, 127.01) - 882.0).abs() < 2.0);
    }
}

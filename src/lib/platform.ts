/**
 * 폰(iOS) 빌드인가. Tauri CLI 가 빌드 때 주는 값이라 번들에 박힌다 — 맥 빌드에선 늘 false 다.
 * 폰에는 파일·코드 실행·캡처·화면 모드·로컬 모델 같은 데스크탑 기능이 없다(docs/neko-sync.md §6.1).
 */
export const IS_PHONE = import.meta.env.TAURI_ENV_PLATFORM === "ios";

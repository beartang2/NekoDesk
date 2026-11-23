import { invoke } from "@tauri-apps/api/core";
import { IS_PHONE } from "../lib/platform";
import type { NekoActivity } from "./engine/neko-engine";
import { useNekoApp } from "./director/stores";

/**
 * 다른 앱 따라 하기(늘 켜짐, macOS). 사용자가 다른 앱에서 하는 일을 고양이가 흉내 낸다(src-tauri/src/ambient.rs).
 *
 * - 글을 치는 동안은 졸지 않는다(감독 졸림 시계가 outside.at 도 본다). 따라 치지는 않는다(0.1.28, 사용자: 네코 타이핑은
 *   네코가 채팅에 글을 남길 때만). 단축키는 치는 걸로 안 센다: 키를 실제로 치고(2초에 3번 넘게, ⌘·⌃ 조합 뺌) 포커스가 글
 *   입력 칸일 때만이다(src-tauri/src/ambient.rs). 다른 앱의 입력 칸은 Rust 가 손쉬운 사용 API 로 보고, 이 앱이 맨 앞이면
 *   여기서 document.activeElement 로 본다.
 * - 맨 앞 앱에 맞춰 한다: 그림 앱이면 그리기, 브라우저면 창밖 보기, 문서면 책 읽기…
 * - 음악이 나오면 하던 것 위에 헤드폰을 얹는다(곁들임, docs/neko-activity-mix.md §1.13).
 * - '앱을 쓰는 중'(lastActiveAt)은 건드리지 않는다 — 산책·기억 정리처럼 '자리 비움'을 보는 일은 그대로다.
 */

/** 맨 앞 앱·키 입력을 읽는 간격 */
const POLL_MS = 1000;
/** 음악 재생을 묻는 간격(osascript 를 띄운다) */
const MUSIC_MS = 15_000;

/** 번들 ID(앞부분이 맞으면) → 활동. 위에 있는 게 먼저 */
const APPS: [prefix: string, activity: NekoActivity][] = [
  // 그림·디자인
  ["com.figma.", "draw"], ["com.adobe.Photoshop", "draw"], ["com.adobe.illustrator", "draw"],
  ["com.bohemiancoding.sketch", "draw"], ["com.apple.freeform", "draw"], ["com.seriflabs.", "draw"], ["com.pixelmator", "draw"],
  // 읽기
  ["com.apple.Preview", "reading"], ["com.apple.iBooksX", "reading"], ["com.adobe.Reader", "reading"], ["notion.id", "reading"],
  ["com.apple.Notes", "reading"], ["md.obsidian", "reading"],
  // 웹 구경 = 창밖 보기
  ["com.apple.Safari", "window"], ["com.google.Chrome", "window"], ["company.thebrowser.", "window"], ["org.mozilla.firefox", "window"],
  ["com.microsoft.edgemac", "window"], ["com.brave.Browser", "window"], ["com.operasoftware.", "window"],
  // 파일 뒤지기
  ["com.apple.finder", "dig"],
  // 달력
  ["com.apple.iCal", "calendar"],
  // 코드·터미널: 키를 안 칠 땐 골똘히
  ["com.microsoft.VSCode", "think"], ["com.apple.dt.Xcode", "think"], ["com.jetbrains.", "think"], ["dev.zed.", "think"],
  ["com.todesktop.", "think"], ["com.apple.Terminal", "think"], ["com.googlecode.iterm2", "think"], ["dev.warp.", "think"],
  ["com.mitchellh.ghostty", "think"],
];

/** 맨 앞 앱의 활동. 모르는 앱이면 null */
export function appActivity(bundle: string | null): NekoActivity | null {
  if (!bundle) return null;
  return APPS.find(([p]) => bundle.startsWith(p))?.[1] ?? null;
}

interface Probe { app: string | null; own: boolean; typed_ago: number; keys: boolean; typing: boolean }

/** 글을 넣는 input 종류(체크박스·버튼·색 고르기 같은 건 아니다) */
const TEXT_TYPES = new Set(["text", "search", "email", "url", "tel", "password", "number", ""]);

/** 이 앱 안에서 포커스가 글 입력 칸인가(input·textarea·contenteditable) */
export function isTextInput(el: Element | null): boolean {
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXT_TYPES.has(el.type) && !el.readOnly && !el.disabled;
  return el instanceof HTMLElement && (el.isContentEditable || ["", "true", "plaintext-only"].includes(el.getAttribute("contenteditable") ?? "-"));
}

/** 글을 치는 중인가: 다른 앱이면 Rust 판정, 이 앱이 맨 앞이면 키를 치고 입력 칸에 포커스 */
export function typingNow(p: Pick<Probe, "own" | "keys" | "typing">, ownTextFocus: boolean): boolean {
  return p.own ? p.keys && ownTextFocus : p.typing;
}

// 아이폰의 userAgent 에도 "like Mac OS X" 가 있어 폰은 따로 뺀다
const IS_MAC = !IS_PHONE && typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/**
 * 폰의 따라 하기. 다른 앱은 못 보니 다른 앱에서 나오는 소리(음악, AVAudioSession)만 따라 한다. 이 앱 입력 칸에 치는 동안은
 * 맥과 같이 졸지 않는다(감독 졸림 시계가 `at` 을 본다) — 따라 치지는 않는다.
 */
function startPhoneAmbient(): void {
  const app = useNekoApp;
  document.addEventListener("input", (e) => {
    if (!(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement)) return;
    app.getState().setOutside({ ...app.getState().outside, at: performance.now() });
  }, true);
  const music = async () => {
    const on = await invoke<boolean>("ambient_music").catch(() => false);
    app.getState().setOutside({ ...app.getState().outside, music: on });
  };
  void music();
  setInterval(() => void music(), MUSIC_MS);
}

let started = false;
/** 메인 창에서 한 번 */
export function startAmbient(): void {
  if (started || !(IS_MAC || IS_PHONE)) return;
  started = true;
  if (IS_PHONE) return startPhoneAmbient();
  let music = false;
  let musicAt = -Infinity;
  const off = () => useNekoApp.getState().setOutside({ ...useNekoApp.getState().outside, activity: null, music: false });

  const tick = async () => {
    // 늘 켜져 있다(설정에서 끄는 스위치는 없앴다). 마당 고양이를 숨긴 동안만 쉰다(보일 것도 없는데 osascript 를 띄울 일이 없다)
    if (useNekoApp.getState().screenHidden) { off(); return; }
    const p = await invoke<Probe>("ambient_probe").catch(() => null);
    if (!p) return;
    const now = performance.now();
    if (now - musicAt >= MUSIC_MS) {
      musicAt = now;
      music = await invoke<boolean>("ambient_music").catch(() => false);
    }
    // 단축키엔 반응하지 않는다: 키를 실제로 치고 입력 칸에 포커스일 때만. 이 앱이 맨 앞이면 다른 앱 활동은 쉰다
    const typing = typingNow(p, isTextInput(document.activeElement));
    const cur = useNekoApp.getState().outside;
    useNekoApp.getState().setOutside({
      // 마지막 키 누름 시각. 졸림 시계가 여기서 센다(치는 동안은 안 존다)
      at: typing ? now - p.typed_ago * 1000 : cur.at,
      activity: p.own ? null : appActivity(p.app),
      // 음악은 이 앱을 쓰는 동안에도 같이 듣는다. 주 활동이 아니라 곁들임이다(감독 derive)
      music,
    });
  };
  setInterval(() => void tick(), POLL_MS);
}

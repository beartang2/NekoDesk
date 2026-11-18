import { invoke } from "@tauri-apps/api/core";
import type { NekoActivity } from "./engine/neko-engine";
import { useNekoApp } from "./director/stores";
import { useSettingsStore } from "../stores/settingsStore";

/**
 * 다른 앱 따라 하기(설정 › 고양이). 사용자가 다른 앱에서 하는 일을 고양이가 흉내 낸다(src-tauri/src/ambient.rs).
 *
 * - 다른 앱에서 키를 치는 중이면 같이 타이핑한다. 그동안은 졸지 않는다(감독 derive 의 outside 층).
 *   키를 멈추면 15초(TYPE_REST_MS)는 타이핑 자세 그대로 손만 쉬며 화면을 본다(엔진 setRest) — 그 안에 다시 치면 이어 친다.
 * - 맨 앞 앱에 맞춰 한다: 그림 앱이면 그리기, 브라우저면 창밖 보기, 문서면 책 읽기…
 * - 음악이 나오면 하던 것 위에 헤드폰을 얹는다(곁들임, docs/neko-activity-mix.md §1.13).
 * - '앱을 쓰는 중'(lastActiveAt)은 건드리지 않는다 — 산책·기억 정리처럼 '자리 비움'을 보는 일은 그대로다.
 */

/** 맨 앞 앱·키 입력을 읽는 간격 */
const POLL_MS = 1000;
/** 음악 재생을 묻는 간격(osascript 를 띄운다) */
const MUSIC_MS = 15_000;
/** 마지막 키 누름이 이보다 가까우면 '치는 중' */
const TYPING_S = 2;

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

interface Probe { app: string | null; own: boolean; typed_ago: number }

const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

let started = false;
/** 메인 창에서 한 번 */
export function startAmbient(): void {
  if (started || !IS_MAC) return;
  started = true;
  let music = false;
  let musicAt = -Infinity;
  const off = () => useNekoApp.getState().setOutside({ ...useNekoApp.getState().outside, typing: false, activity: null, music: false });

  const tick = async () => {
    // 마당 고양이를 숨긴 동안도 쉰다(보일 것도 없는데 osascript 를 띄울 일이 없다)
    if (!useSettingsStore.getState().nekoFollowApps || useNekoApp.getState().screenHidden) { off(); return; }
    const p = await invoke<Probe>("ambient_probe").catch(() => null);
    if (!p) return;
    const now = performance.now();
    if (now - musicAt >= MUSIC_MS) {
      musicAt = now;
      music = await invoke<boolean>("ambient_music").catch(() => false);
    }
    // 이 앱이 맨 앞이면 앱 안 입력이다(감독이 따로 센다). 다른 앱 활동도 그동안은 쉰다
    const typing = !p.own && p.typed_ago < TYPING_S;
    const cur = useNekoApp.getState().outside;
    useNekoApp.getState().setOutside({
      typing,
      // 마지막 키 누름 시각. 키를 멈춘 뒤 15초 손 쉬기(감독 TYPE_REST_MS)·졸림 시계가 여기서 센다
      at: typing ? now - p.typed_ago * 1000 : cur.at,
      activity: p.own ? null : appActivity(p.app),
      // 음악은 이 앱을 쓰는 동안에도 같이 듣는다. 주 활동이 아니라 곁들임이다(감독 derive)
      music,
    });
  };
  setInterval(() => void tick(), POLL_MS);
}

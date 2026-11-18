import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { QuickAsk } from "./components/QuickAsk";
import { CaptureOverlay } from "./components/CaptureOverlay";
import { ViewerWindow } from "./components/Viewer";
import { GlowAlert } from "./components/GlowAlert";
import { NekoScreen } from "./neko/NekoScreen";
import { NekoDecorScreen } from "./neko/NekoDecorScreen";
import { NekoPanelWindow, type NekoPanelKind } from "./neko/NekoPanelWindow";
import { startNekoWindowSync } from "./neko/windowSync";
import "./App.css";
import { loadHome } from "./lib/home";
import { pruneOldSessions } from "./stores/sessionStore";
import { useSettingsStore } from "./stores/settingsStore";
import { startMemoryTidy } from "./neko/memoryTidy";
import { startAmbient } from "./neko/ambient";
import { startSync } from "./lib/sync";


// 같은 번들을 여러 창이 쓴다. ⌃⇧N 창("quick")은 입력만 받고, 캡처 막("capture-N")은
// 고르기만 하고, 뷰어("viewer")는 그림·파일만 보여 주고, 빛 창("glow")은 일정 알림 때 테두리만
// 빛내고, 화면 창("neko-screen")은 모니터 화면 자리의 네코만 그리고, 꾸미기·선물함 창("neko-customize"·
// "neko-gifts")은 설정에서 따로 띄운 그것만, 나머지는 메인 창이 한다.
const label = getCurrentWindow().label;
const isQuick = label === "quick";
const isCapture = label.startsWith("capture-");
const isViewer = label === "viewer";
const isGlow = label === "glow";
const isNekoScreen = label === "neko-screen";
// 마당 선물 창(고양이가 없는 모니터마다, neko_screen.rs)
const isNekoDecor = label.startsWith("neko-decor-");
// 설정에서 따로 띄우는 창(네코 꾸미기·선물함, panel_open)
const panel = label === "neko-customize" || label === "neko-gifts" ? (label as NekoPanelKind) : null;
if (isQuick) document.documentElement.classList.add("quick-window");
// 빛 창·화면 네코 창도 캡처 막처럼 바탕이 투명해야 한다.
if (isCapture || isGlow || isNekoScreen || isNekoDecor) document.documentElement.classList.add("capture-window");
if (isViewer) document.documentElement.classList.add("viewer-window");

// 오래된 대화 지우기(설정). 메인 창만, 켤 때 한 번
if (!isQuick && !isCapture && !isViewer && !isGlow && !isNekoScreen && !isNekoDecor && !panel) {
  void pruneOldSessions(useSettingsStore.getState().sessionRetention).catch(() => {});
  // 세션 목록·같이 쓰는 설정을 DB 에서 읽고, 다른 기기에서 온 것을 받는다(설정 › 동기화)
  startSync();
  // 꾸미기·선물함 창과 네코 외형·자리·선물을 맞춘다
  startNekoWindowSync();
  // 쉴 때 기억 정리(설정 › 네코가 기억하는 것). 졸 때 하루 한 번
  startMemoryTidy();
  // 다른 앱 따라 하기(설정 › 고양이)
  startAmbient();
}

// Tab 은 입력창 사이만 오간다. 버튼까지 돌면 포커스가 어디 있는지 안 보여 헤맨다.
// 모달이 떠 있으면 그 안에서만 돈다.
const TEXT_FIELDS =
  'textarea, input:not([type="checkbox"], [type="radio"], [type="range"], [type="button"], [type="submit"], [type="hidden"], [type="file"], [type="color"])';
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    const scopes = document.querySelectorAll(".menu-modal, .settings-modal, [role='dialog']");
    const scope = scopes[scopes.length - 1] ?? document;
    const fields = [...scope.querySelectorAll<HTMLInputElement>(TEXT_FIELDS)].filter(
      (el) => !el.disabled && el.getClientRects().length > 0,
    );
    if (!fields.length) return;
    const i = fields.indexOf(document.activeElement as HTMLInputElement);
    const step = e.shiftKey ? -1 : 1;
    const next = i < 0 ? (e.shiftKey ? fields.length - 1 : 0) : (i + step + fields.length) % fields.length;
    fields[next].focus();
  },
  true,
);

// 홈 경로를 화면·Claude 에서 ~ 로 가리려고 켤 때 한 번 가져온다(lib/home). 받은 뒤에 그린다 —
// 말풍선은 메모라 한 번 그린 뒤 다시 안 그리므로, 먼저 그리면 가리기 전 경로가 그대로 남는다.
void loadHome().finally(() =>
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        {isCapture ? <CaptureOverlay /> : isQuick ? <QuickAsk /> : isViewer ? <ViewerWindow /> : isGlow ? <GlowAlert /> : isNekoScreen ? <NekoScreen /> : isNekoDecor ? <NekoDecorScreen /> : panel ? <NekoPanelWindow kind={panel} /> : <App />}
      </ErrorBoundary>
    </React.StrictMode>
  )
);

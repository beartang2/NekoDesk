import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { QuickAsk } from "./components/QuickAsk";
import { CaptureOverlay } from "./components/CaptureOverlay";
import { ViewerWindow } from "./components/Viewer";
import { GlowAlert } from "./components/GlowAlert";
import "./App.css";
import { loadHome } from "./lib/home";


// 같은 번들을 여러 창이 쓴다. ⌃⇧N 창("quick")은 입력만 받고, 캡처 막("capture-N")은
// 고르기만 하고, 뷰어("viewer")는 그림·파일만 보여 주고, 빛 창("glow")은 일정 알림 때 테두리만
// 빛내고, 나머지는 메인 창이 한다.
const label = getCurrentWindow().label;
const isQuick = label === "quick";
const isCapture = label.startsWith("capture-");
const isViewer = label === "viewer";
const isGlow = label === "glow";
if (isQuick) document.documentElement.classList.add("quick-window");
// 빛 창도 캡처 막처럼 바탕이 투명해야 한다.
if (isCapture || isGlow) document.documentElement.classList.add("capture-window");
if (isViewer) document.documentElement.classList.add("viewer-window");

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
        {isCapture ? <CaptureOverlay /> : isQuick ? <QuickAsk /> : isViewer ? <ViewerWindow /> : isGlow ? <GlowAlert /> : <App />}
      </ErrorBoundary>
    </React.StrictMode>
  )
);

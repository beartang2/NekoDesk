import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { QuickAsk } from "./components/QuickAsk";
import { CaptureOverlay } from "./components/CaptureOverlay";
import { ViewerWindow } from "./components/Viewer";
import "./App.css";

// 같은 번들을 여러 창이 쓴다. ⌃⇧N 창("quick")은 입력만 받고, 캡처 막("capture-N")은
// 고르기만 하고, 뷰어("viewer")는 그림·파일만 보여 주고, 나머지는 메인 창이 한다.
const label = getCurrentWindow().label;
const isQuick = label === "quick";
const isCapture = label.startsWith("capture-");
const isViewer = label === "viewer";
if (isQuick) document.documentElement.classList.add("quick-window");
if (isCapture) document.documentElement.classList.add("capture-window");
if (isViewer) document.documentElement.classList.add("viewer-window");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      {isCapture ? <CaptureOverlay /> : isQuick ? <QuickAsk /> : isViewer ? <ViewerWindow /> : <App />}
    </ErrorBoundary>
  </React.StrictMode>
);

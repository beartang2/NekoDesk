import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { QuickAsk } from "./components/QuickAsk";
import "./App.css";

// 같은 번들을 두 창이 쓴다. ⌃⇧N 창("quick")은 입력만 받고, 나머지는 메인 창이 한다.
const isQuick = getCurrentWindow().label === "quick";
if (isQuick) document.documentElement.classList.add("quick-window");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>{isQuick ? <QuickAsk /> : <App />}</ErrorBoundary>
  </React.StrictMode>
);

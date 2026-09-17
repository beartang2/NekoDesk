import React, { useEffect, useRef, useState } from "react";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUp, Clipboard, TextSelect } from "lucide-react";
import { applyThemeColors } from "../theme-colors";
import {
  QUICK_ASK_EVENT,
  QUICK_CONTEXT_EVENT,
  type QuickAskPayload,
  type QuickContext,
} from "../lib/quick-ask";
import "./QuickAsk.css";

const EMPTY: QuickContext = { selection: null, clipboard: null, app: null };

function snippet(s: string, max = 42): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** 메인 창과 같은 테마로 뜬다. 같은 origin 이라 localStorage 를 공유한다. */
function syncTheme() {
  const isDark = localStorage.getItem("nekodesk_theme") === "dark";
  document.documentElement.classList.toggle("light", !isDark);
  applyThemeColors(isDark);
  getCurrentWindow().setTheme(isDark ? "dark" : "light").catch(() => {});
}

/**
 * ⌃⇧N 으로 뜨는 한 줄 입력창.
 *
 * 선택한 텍스트는 기본으로 포함, 클립보드는 기본으로 뺀다. 선택은 방금 한 일이라
 * 물어보려는 대상일 가능성이 높지만, 클립보드는 몇 시간 전에 복사한 비밀번호일 수도
 * 있다 — 그걸 말없이 대화 기록에 남기면 안 된다.
 */
export function QuickAsk() {
  const [ctx, setCtx] = useState<QuickContext>(EMPTY);
  const [text, setText] = useState("");
  const [useSelection, setUseSelection] = useState(true);
  const [useClipboard, setUseClipboard] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    syncTheme();
    const unlisten = listen<QuickContext>(QUICK_CONTEXT_EVENT, (e) => {
      syncTheme();
      setCtx(e.payload);
      setText("");
      setUseSelection(true);
      setUseClipboard(false);
      // 창이 막 보이는 순간이라 한 틱 뒤에 잡아야 포커스가 들어간다.
      setTimeout(() => inputRef.current?.focus(), 0);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const hide = () => { getCurrentWindow().hide().catch(() => {}); };

  async function submit() {
    const trimmed = text.trim();
    if (!trimmed) return;
    const payload: QuickAskPayload = {
      text: trimmed,
      selection: useSelection && ctx.selection ? ctx.selection : undefined,
      clipboard: useClipboard && ctx.clipboard ? ctx.clipboard : undefined,
      app: ctx.app ?? undefined,
    };
    await emitTo("main", QUICK_ASK_EVENT, payload);
    hide();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); hide(); }
    // 한글 조합 중 Enter 는 조합 확정이지 전송이 아니다.
    if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  }

  const hasContext = !!(ctx.selection || ctx.clipboard);

  return (
    <div className="quick" onKeyDown={onKeyDown}>
      <div className="quick__row">
        <span className="quick__cat" aria-hidden>🐱</span>
        <input
          ref={inputRef}
          className="quick__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={ctx.selection ? "선택한 글에 대해 물어봐" : "네코에게 물어봐"}
          autoFocus
          spellCheck={false}
        />
        <button className="quick__send" onClick={() => void submit()} disabled={!text.trim()} title="보내기">
          <ArrowUp size={15} strokeWidth={2.5} />
        </button>
      </div>

      <div className="quick__footer">
        <div className="quick__chips">
          {ctx.selection && (
            <button
              className={`quick__chip ${useSelection ? "quick__chip--on" : ""}`}
              onClick={() => setUseSelection((v) => !v)}
              title={ctx.selection}
            >
              <TextSelect size={11} />
              <span className="quick__chip-label">{ctx.app ? `${ctx.app} 선택` : "선택한 글"}</span>
              <span className="quick__chip-text">{snippet(ctx.selection)}</span>
            </button>
          )}
          {ctx.clipboard && ctx.clipboard !== ctx.selection && (
            <button
              className={`quick__chip ${useClipboard ? "quick__chip--on" : ""}`}
              onClick={() => setUseClipboard((v) => !v)}
              title={ctx.clipboard}
            >
              <Clipboard size={11} />
              <span className="quick__chip-label">클립보드</span>
              <span className="quick__chip-text">{snippet(ctx.clipboard, 28)}</span>
            </button>
          )}
          {!hasContext && <span className="quick__hint">글을 선택하고 부르면 같이 보내져</span>}
        </div>
        <span className="quick__keys"><kbd>↵</kbd> 보내기 <kbd>esc</kbd> 닫기</span>
      </div>
    </div>
  );
}

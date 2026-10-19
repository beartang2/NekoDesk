import React, { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ArrowUp, Camera, Clipboard, TextSelect, X } from "lucide-react";
import { syncWindowTheme } from "../lib/window-theme";
import { resizeImageForLlm } from "../lib/image";
import { NekoHead } from "../cat/NekoHead";
import { reloadCatVariant, useCatStore } from "../stores/catStore";
import {
  QUICK_ACTIONS,
  QUICK_ASK_EVENT,
  QUICK_CONTEXT_EVENT,
  type QuickAction,
  type QuickAskPayload,
  type QuickContext,
} from "../lib/quick-ask";
import "./QuickAsk.css";

const EMPTY: QuickContext = { selection: null, clipboard: null, app: null };

/**
 * 화면 캡처는 글씨가 많다. 채팅 첨부(768)보다 크게 넘겨야 작은 글씨까지 읽히고, 뷰어로 볼 때도
 * 선명하다. 2048 이면 레티나 창 하나가 거의 원래 크기로 담긴다. 모델은 이미지 크기만큼
 * 토큰을 쓰는데(2048×1280 이면 3천 남짓) 컨텍스트 65K 엔 여유가 있다.
 */
const CAPTURE_MAX_PX = 2048;
/** 무손실로 찍어 와 한 번만 JPEG 로 줄인다. 0.9 면 글씨 테두리가 번지지 않는다. */
const CAPTURE_OUT = { type: "image/jpeg", quality: 0.9 } as const;

/** 캡처만 하고 아무것도 안 쳤을 때 보낼 말. */
const IMAGE_DEFAULT_TEXT = "이 화면을 설명해줘.";

function snippet(s: string, max = 42): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}


/**
 * ⌃⇧N 으로 뜨는 한 줄 입력창.
 *
 * 선택한 텍스트는 기본으로 포함, 클립보드는 기본으로 뺀다. 선택은 방금 한 일이라
 * 물어보려는 대상일 가능성이 높지만, 클립보드는 몇 시간 전에 복사한 비밀번호일 수도
 * 있다 — 그걸 말없이 대화 기록에 남기면 안 된다.
 */
export function QuickAsk() {
  const variantId = useCatStore((s) => s.variantId);
  const [ctx, setCtx] = useState<QuickContext>(EMPTY);
  const [text, setText] = useState("");
  const [useSelection, setUseSelection] = useState(true);
  const [useClipboard, setUseClipboard] = useState(false);
  const [image, setImage] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    syncWindowTheme();
    const unlisten = listen<QuickContext>(QUICK_CONTEXT_EVENT, (e) => {
      syncWindowTheme();
      reloadCatVariant();
      setCtx(e.payload);
      setText("");
      setUseSelection(true);
      setUseClipboard(false);
      setImage(null);
      // 창이 막 보이는 순간이라 한 틱 뒤에 잡아야 포커스가 들어간다.
      setTimeout(() => inputRef.current?.focus(), 0);
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  const hide = () => { getCurrentWindow().hide().catch(() => {}); };

  /** 창을 숨기고 영역을 고르게 한 뒤 다시 띄운다. 그만두면 아무것도 안 붙는다. */
  async function capture() {
    setCapturing(true);
    try {
      const shot = await invoke<string | null>("quick_capture");
      if (shot) setImage(await resizeImageForLlm(await (await fetch(shot)).blob(), CAPTURE_MAX_PX, CAPTURE_OUT));
    } catch { /* 권한 거절 등 — 캡처 없이 계속 쓴다 */ }
    setCapturing(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  async function submit(action?: QuickAction) {
    const trimmed = action ?? (text.trim() || (image ? IMAGE_DEFAULT_TEXT : ""));
    if (!trimmed) return;
    const payload: QuickAskPayload = {
      text: trimmed,
      action,
      selection: useSelection && ctx.selection ? ctx.selection : undefined,
      clipboard: useClipboard && ctx.clipboard ? ctx.clipboard : undefined,
      app: ctx.app ?? undefined,
      image: image ?? undefined,
    };
    await emitTo("main", QUICK_ASK_EVENT, payload);
    hide();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); hide(); }
    // 한글 조합 중 Enter 는 조합 확정이지 전송이 아니다.
    if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); }
  }

  const hasContext = !!(ctx.selection || ctx.clipboard || image);
  // 선택한 글이 들어갈 때만. 글 없이 "요약해줘" 만 가면 무엇을 요약하라는지 모른다.
  const showActions = !!ctx.selection && useSelection && !text.trim();

  return (
    <div className="quick" onKeyDown={onKeyDown}>
      <div className="quick__row">
        <NekoHead className="quick__cat" variantId={variantId} />
        <input
          ref={inputRef}
          className="quick__input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={
            image ? "캡처한 화면에 대해 물어봐" : ctx.selection ? "선택한 글에 대해 물어봐" : "네코에게 물어봐"
          }
          autoFocus
          spellCheck={false}
        />
        <button
          className="quick__capture"
          onClick={() => void capture()}
          disabled={capturing}
          title="화면 일부를 잘라 같이 보내기"
        >
          <Camera size={16} strokeWidth={2} />
        </button>
        <button className="quick__send" onClick={() => void submit()} disabled={!text.trim() && !image} title="보내기">
          <ArrowUp size={15} strokeWidth={2.5} />
        </button>
      </div>

      <div className="quick__footer">
        <div className="quick__chips">
          {image && (
            <button className="quick__chip quick__chip--on" onClick={() => setImage(null)} title="캡처 빼기">
              <img className="quick__thumb" src={image} alt="" />
              <span className="quick__chip-label">화면 캡처</span>
              <X size={11} />
            </button>
          )}
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
        {showActions ? (
          <div className="quick__actions">
            {QUICK_ACTIONS.map((action) => (
              <button key={action} className="quick__action" onClick={() => void submit(action)}>
                {action}
              </button>
            ))}
          </div>
        ) : (
          <span className="quick__keys"><kbd>↵</kbd> 보내기 <kbd>esc</kbd> 닫기</span>
        )}
      </div>
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Copy, Download, Minus, Plus } from "lucide-react";
import { syncWindowTheme } from "../lib/window-theme";
import "./Viewer.css";

/** 뷰어에 띄울 것. 그림은 dataUrl, 글 파일은 text. 둘 다 없으면 미리보기 없음. */
export interface ViewerItem {
  name: string;
  dataUrl?: string;
  text?: string;
}

/**
 * 채팅의 그림·파일을 누르면 부른다. 앱 안 팝업이 아니라 따로 뜬 "뷰어" 창에 띄운다 —
 * 옮겨 두고 보거나 확대해서 볼 수 있게. 창은 하나라 떠 있으면 내용만 바뀐다(lib.rs viewer_open).
 */
export function openViewer(item: ViewerItem) {
  void invoke("viewer_open", { item });
}

/** 다운로드할 때 쓸 이름. 확장자는 그림 형식에서 뽑는다("네코 그림 1" → "네코 그림 1.png"). */
export function imageName(base: string, dataUrl: string): string {
  const kind = /^data:image\/([a-z0-9.+-]+)/i.exec(dataUrl)?.[1]?.toLowerCase() ?? "png";
  return `${base}.${kind === "jpeg" ? "jpg" : kind.replace("svg+xml", "svg")}`;
}

const isImage = (item: ViewerItem) => !!item.dataUrl?.startsWith("data:image/");

/** 다른 앱이 가장 잘 받는 PNG 로 바꾼다. JPEG 를 그대로 올리면 붙여넣기를 못 하는 앱이 있다. */
function toPng(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")!.drawImage(img, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
/** 버튼·⌘+/⌘− 한 번에 바뀌는 배율. */
const STEP = 1.25;
const TEXT_FONT_PX = 12.5;

const clamp = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, v));

/**
 * 뷰어 창 하나를 채우는 화면. 확대·축소: 트랙패드 핀치, ⌘+ ⌘− ⌘0, 위 막대의 버튼.
 * 그림은 커서 자리를 중심으로 커지고, 창보다 크면 끌어서 옮겨 본다. 글은 글자 크기가 바뀐다.
 */
export function ViewerWindow() {
  const [item, setItem] = useState<ViewerItem | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  /** 창에 맞춘 상태. 창 크기가 바뀌면 다시 맞춘다. 직접 확대·축소하면 풀린다. */
  const [fit, setFit] = useState(true);
  const [status, setStatus] = useState<{ text: string; path?: string } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  useEffect(() => {
    const load = () => {
      syncWindowTheme();
      invoke<ViewerItem | null>("viewer_item").then((next) => {
        setItem(next);
        setNatural(null);
        setFit(true);
        setScale(1);
        setStatus(null);
      });
    };
    load();
    const unlisten = listen("viewer-open", load, { target: getCurrentWindow().label });
    return () => void unlisten.then((f) => f());
  }, []);

  const image = !!item && isImage(item);

  /** 창 안에 다 들어오는 배율. 원래 크기보다 키우지는 않는다. */
  const fitScale = useCallback(() => {
    const el = scroller.current;
    if (!el || !natural) return 1;
    return Math.min(1, el.clientWidth / natural.w, el.clientHeight / natural.h);
  }, [natural]);

  // 맞춤 상태면 그림을 처음 읽었을 때와 창 크기가 바뀔 때마다 다시 맞춘다.
  useLayoutEffect(() => {
    if (!image || !fit) return;
    setScale(fitScale());
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(fitScale()));
    ro.observe(el);
    return () => ro.disconnect();
  }, [image, fit, fitScale]);

  /**
   * cx, cy(보이는 칸 기준) 자리를 붙잡고 배율을 바꾼다 — 핀치한 곳이 손가락 밑에 남는다.
   *
   * 핀치는 한 프레임에 이벤트가 여러 번 온다. 그때마다 그리면 버벅여서, 마지막 값만 모아 두고
   * 프레임마다 한 번 반영한다. 반영은 flushSync 로 바로 그린 뒤 스크롤을 맞춘다 — 다음
   * 프레임에 맞추면 한 프레임 동안 엉뚱한 곳을 보여 줘 덜컹였다.
   */
  const pending = useRef<{ scale: number; x?: number; y?: number } | null>(null);
  const frame = useRef(0);
  const [zooming, setZooming] = useState(false);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const zoomTo = useCallback((next: number, cx?: number, cy?: number) => {
    pending.current = { scale: clamp(next), x: cx, y: cy };
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const p = pending.current;
      pending.current = null;
      const el = scroller.current;
      if (!p || !el) return;
      const prev = scaleRef.current;
      const x = p.x ?? el.clientWidth / 2;
      const y = p.y ?? el.clientHeight / 2;
      const contentX = (el.scrollLeft + x) / prev;
      const contentY = (el.scrollTop + y) / prev;
      flushSync(() => {
        setFit(false);
        setScale(p.scale);
        setZooming(true);
      });
      clearTimeout(settle.current);
      settle.current = setTimeout(() => setZooming(false), 180);
      scaleRef.current = p.scale;
      el.scrollLeft = contentX * p.scale - x;
      el.scrollTop = contentY * p.scale - y;
    });
  }, []);
  useEffect(() => () => {
    cancelAnimationFrame(frame.current);
    clearTimeout(settle.current);
  }, []);

  const resetFit = () => {
    setFit(true);
    if (!image) setScale(1);
  };

  // 핀치: 크로뮴 계열은 ctrl+휠로, WebKit 은 gesture 이벤트로 온다. 둘 다 받는다.
  // React 의 휠 리스너는 수동(passive)이라 막을 수 없어 직접 단다.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let base = 1;
    const at = (e: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top] as const;
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      zoomTo(scaleRef.current * Math.exp(-e.deltaY * 0.01), ...at(e));
    };
    type Gesture = Event & { scale: number; clientX: number; clientY: number };
    const onStart = (e: Event) => {
      e.preventDefault();
      base = scaleRef.current;
    };
    const onChange = (e: Event) => {
      e.preventDefault();
      const g = e as Gesture;
      zoomTo(base * g.scale, ...at(g));
      // WebKit 은 손을 떼도 gestureend 전에 몇 번 더 보낸다. 마지막 값이 그대로 남는다.
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("gesturestart", onStart);
    el.addEventListener("gesturechange", onChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onStart);
      el.removeEventListener("gesturechange", onChange);
    };
  }, [zoomTo, item]);

  // ⌘+ ⌘− ⌘0(맞춤) ⌘1(원래 크기), esc 로 닫기.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void getCurrentWindow().close();
        return;
      }
      if (!e.metaKey) return;
      if (e.key === "=" || e.key === "+") zoomTo(scaleRef.current * STEP);
      else if (e.key === "-") zoomTo(scaleRef.current / STEP);
      else if (e.key === "0") resetFit();
      else if (e.key === "1") zoomTo(1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomTo, image]);

  // 창보다 큰 그림은 끌어서 옮겨 본다.
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [panning, setPanning] = useState(false);
  function onMouseDown(e: React.MouseEvent) {
    const el = scroller.current;
    if (!image || !el || e.button !== 0) return;
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    e.preventDefault();
    pan.current = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop };
    setPanning(true);
    const move = (ev: MouseEvent) => {
      const p = pan.current;
      if (!p) return;
      el.scrollLeft = p.left - (ev.clientX - p.x);
      el.scrollTop = p.top - (ev.clientY - p.y);
    };
    const up = () => {
      pan.current = null;
      setPanning(false);
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  async function copy() {
    if (!item) return;
    try {
      if (image) await invoke("copy_image", { dataUrl: await toPng(item.dataUrl!) });
      else await navigator.clipboard.writeText(item.text ?? "");
      setStatus({ text: "복사됨" });
    } catch (e) {
      setStatus({ text: `복사하지 못했습니다: ${e}` });
    }
  }

  async function download() {
    if (!item) return;
    try {
      const path = await invoke<string>("save_download", {
        name: item.name,
        dataUrl: image ? item.dataUrl : null,
        text: image ? null : item.text,
      });
      setStatus({ text: "다운로드 폴더에 저장됨", path });
    } catch (e) {
      setStatus({ text: `저장하지 못했습니다: ${e}` });
    }
  }

  if (!item) return <div className="vw" />;
  const canSave = image || !!item.text;
  const zoomable = image || !!item.text;

  return (
    <div className="vw">
      <div className="vw__bar">
        {zoomable && (
          <div className="vw__zoom">
            <button className="vw__btn vw__btn--icon" onClick={() => zoomTo(scale / STEP)} title="축소 (⌘−)">
              <Minus size={14} />
            </button>
            <span className="vw__pct">{Math.round(scale * 100)}%</span>
            <button className="vw__btn vw__btn--icon" onClick={() => zoomTo(scale * STEP)} title="확대 (⌘+)">
              <Plus size={14} />
            </button>
            <button className={`vw__btn ${fit ? "vw__btn--on" : ""}`} onClick={resetFit} title="창에 맞춤 (⌘0)">
              맞춤
            </button>
            <button className="vw__btn" onClick={() => zoomTo(1)} title="원래 크기 (⌘1)">
              100%
            </button>
          </div>
        )}
        <span className="vw__status">
          {status?.text}
          {status?.path && (
            <button className="vw__link" onClick={() => invoke("reveal_in_finder", { path: status.path })}>
              Finder에서 보기
            </button>
          )}
        </span>
        {canSave && (
          <>
            <button className="vw__btn" onClick={() => void copy()} title="복사">
              <Copy size={14} /> 복사
            </button>
            <button className="vw__btn" onClick={() => void download()} title="다운로드 폴더에 저장">
              <Download size={14} /> 다운로드
            </button>
          </>
        )}
      </div>

      <div
        ref={scroller}
        className={`vw__body ${panning ? "vw__body--panning" : ""}`}
        onMouseDown={onMouseDown}
      >
        {image ? (
          <div className="vw__stage">
            {/* 그림은 원래 크기로 한 번 그려 두고 transform 으로만 키운다 — 배율이 바뀔 때마다
                그림을 다시 그리지 않아 핀치가 매끄럽다. 바깥 칸은 스크롤 범위용으로 크기만 바뀐다. */}
            <div
              className="vw__canvas"
              style={natural ? { width: natural.w * scale, height: natural.h * scale } : undefined}
            >
              <img
                className={`vw__image ${zooming ? "vw__image--zooming" : ""}`}
                src={item.dataUrl}
                alt={item.name}
                draggable={false}
                onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                style={
                  natural
                    ? { width: natural.w, height: natural.h, transform: `scale(${scale})` }
                    : { visibility: "hidden" }
                }
              />
            </div>
          </div>
        ) : item.text ? (
          <pre className="vw__text" style={{ fontSize: TEXT_FONT_PX * scale }}>
            {item.text}
          </pre>
        ) : (
          <p className="vw__empty">이 파일은 미리보기를 지원하지 않습니다.</p>
        )}
      </div>
    </div>
  );
}

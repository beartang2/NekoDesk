import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
} from "react";

/**
 * 사이드바 / 우측 패널의 표시·너비·드래그 리사이즈 상태.
 *
 * 순수 UI 레이아웃 상태라 App.tsx 에서 분리한다(agent/chat 과 결합 0).
 * App 은 결과만 받아 쓰고, mousemove/mouseup/⌘0 리스너와 드래그 계산은 여기 캡슐화한다.
 */

const MIN_W = 160;
const MAX_W = 400;
const DEFAULT_SIDEBAR_W = 220;
const DEFAULT_RIGHT_W = 210;

type DragType = "sidebar" | "right";

export function useLayout() {
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [rightPanelVisible, setRightPanelVisible] = useState(true);
  const [sidebarW, setSidebarW] = useState(DEFAULT_SIDEBAR_W);
  const [rightPanelW, setRightPanelW] = useState(DEFAULT_RIGHT_W);
  const [isDragging, setIsDragging] = useState<DragType | null>(null);
  const dragRef = useRef<{ type: DragType; startX: number; startW: number } | null>(null);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      if (!dragRef.current) return;
      const { type, startX, startW } = dragRef.current;
      const delta = e.clientX - startX;
      if (type === "sidebar") {
        setSidebarW(Math.max(MIN_W, Math.min(MAX_W, startW + delta)));
      } else {
        setRightPanelW(Math.max(MIN_W, Math.min(MAX_W, startW - delta)));
      }
    }
    function onMouseUp() {
      dragRef.current = null;
      setIsDragging(null);
    }
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // ⌘0 → 패널 너비 초기화
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey && e.key === "0") {
        setSidebarW(DEFAULT_SIDEBAR_W);
        setRightPanelW(DEFAULT_RIGHT_W);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function startDrag(type: DragType, e: ReactMouseEvent) {
    e.preventDefault();
    const startW = type === "sidebar" ? sidebarW : rightPanelW;
    dragRef.current = { type, startX: e.clientX, startW };
    setIsDragging(type);
  }

  const appStyle = {
    "--sidebar-w": sidebarVisible ? `${sidebarW}px` : "0px",
    "--right-panel-w": rightPanelVisible ? `${rightPanelW}px` : "0px",
  } as CSSProperties;

  return {
    sidebarVisible,
    setSidebarVisible,
    rightPanelVisible,
    setRightPanelVisible,
    // 게임이 시작되면 사이드바를 넓혔다가 복원하는 등 외부에서 너비를 직접 세팅한다.
    setSidebarW,
    setRightPanelW,
    isDragging,
    startDrag,
    appStyle,
  };
}

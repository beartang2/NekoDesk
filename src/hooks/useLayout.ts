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
// 고양이 칸의 밥 주기·놀아주기가 이모지가 아니라 글자로 보이는 가장 좁은 폭(고양이 칸 220px)에
// 카드 왼쪽 틈(--gutter 8px)을 더한 값. ⌘0 이 여기로 돌아온다.
export const DEFAULT_SIDEBAR_W = 228;
const DEFAULT_RIGHT_W = 210;
/** 가운데 대화 칸이 이보다 좁아지면 오른쪽 패널을 접는다 — 한 줄에 열 글자 남짓이라 읽기 힘들었다. */
const CHAT_MIN_W = 420;

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

  // 창이 좁아져 가운데 대화 칸이 너무 좁아지면 오른쪽 패널을 접고, 다시 넓어지면 접기 전 모습으로 편다.
  // 열고 닫힘은 .app 의 grid-template-columns 전환이 그대로 움직여 준다. 경계에서 깜빡이지 않게 접는 선과
  // 펴는 선을 40px 벌려 두고, 사용자가 손으로 열고 닫은 건 건드리지 않는다(창 폭이 경계를 넘을 때만 바꾼다).
  const live = useRef({ visible: rightPanelVisible, sidebarW, rightPanelW });
  live.current = { visible: rightPanelVisible, sidebarW, rightPanelW };
  useEffect(() => {
    const room = () => window.innerWidth - live.current.sidebarW - live.current.rightPanelW;
    let narrow = false;
    let autoClosed = false;
    function onResize() {
      if (!narrow && room() < CHAT_MIN_W) {
        narrow = true;
        autoClosed = live.current.visible;
        setRightPanelVisible(false);
      } else if (narrow && room() >= CHAT_MIN_W + 40) {
        narrow = false;
        if (autoClosed) setRightPanelVisible(true);
        autoClosed = false;
      }
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
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

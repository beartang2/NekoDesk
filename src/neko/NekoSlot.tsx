import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTrackpadPet } from "../hooks/useTrackpadPet";
import { ensureNeko, nekoCanvas, useNekoController } from "./nekoHost";
import { useNekoStore, type NekoPlacement } from "./nekoStore";
import { NekoAway } from "./NekoAway";
import { RoomGifts } from "./NekoRoom";
import { Map as MapIcon } from "lucide-react";
import { LastWalkModal, WalkMap } from "../components/WalkMap";
import type { Walk } from "../lib/walk";
import { useNekoGifts } from "./gifts";
import "./NekoSlot.css";

/**
 * 네코가 들어가는 자리. 앱엔 사이드바 패널 자리와 채팅 바 아래 자리 두 개가 있고,
 * 설정의 '채팅 바 아래로 내리기'에 맞는 자리 하나에만 캔버스가 붙는다(캔버스·엔진은 nekoHost 에 하나).
 * 위쪽 가장자리를 끌어서 높이를 바꾼다(고양이 크기가 높이를 따라간다).
 * 산책 중(away)엔 자리(높이)는 그대로 두고 고양이 대신 산책 나간 장면(NekoAway)을 그린다. 엔진은 멈춘다.
 */
export function NekoSlot({ placement, onRubPet, away = false, walk = null, isDark = false }: {
  placement: NekoPlacement;
  onRubPet: () => void;
  away?: boolean;
  /** 산책 기록(App). 산책 중엔 지도를, 다녀온 뒤엔 지난 산책 지도 버튼을 띄운다 */
  walk?: Walk | null;
  isDark?: boolean;
}) {
  const active = useNekoStore((s) => s.stage.placement === placement);
  const height = useNekoStore((s) => (placement === "sidebar" ? s.stage.sidebarH : s.stage.dockH));
  const setStageHeight = useNekoStore((s) => s.setStageHeight);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const ctrl = useNekoController();
  const [lastWalkOpen, setLastWalkOpen] = useState(false);

  // 이 자리가 고른 자리면 캔버스를 데려온다
  useLayoutEffect(() => {
    const host = stageRef.current;
    if (!active || away || !host) return;
    const cv = nekoCanvas();
    host.appendChild(cv);
    const c = ensureNeko();
    c.resume(); // 산책에서 돌아옴
    c.resize();
    return () => {
      if (cv.parentNode === host) host.removeChild(cv);
    };
  }, [active, away]);
  // 산책 중엔 그릴 자리가 없다
  useLayoutEffect(() => { if (active && away) ctrl?.pause(); }, [ctrl, active, away]);

  // 놓아 둔 선물을 우클릭하면 그 오른쪽 위에 '정리' 버튼. 누르면 선물함으로, 다른 데를 누르거나 Esc 면 닫는다
  const [decorMenu, setDecorMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => (ctrl && active ? ctrl.on("decorMenu", setDecorMenu) : undefined), [ctrl, active]);
  useEffect(() => {
    if (!decorMenu) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as Element)?.closest?.(".neko-slot__tidy")) setDecorMenu(null);
    };
    const t = setTimeout(() => setDecorMenu(null), 6000); // 그냥 두면 저절로 닫힌다
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close);
    return () => { clearTimeout(t); window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", close); };
  }, [decorMenu]);

  // 쓰다듬기: 고양이 몸 위에서 왔다 갔다 문지를 때만(useTrackpadPet). 탭은 엔진이 따로 쓰다듬기로 친다.
  const rub = useCallback(() => {
    // 너무 오래 만져 짜증 나면(react 가 false) 놀이 게이지는 오르지 않는다
    if (ctrl && !ctrl.react("pet")) return;
    onRubPet();
  }, [ctrl, onRubPet]);
  const { onBodyMove, onBodyLeave, setHeld } = useTrackpadPet(rub);
  // 잡고 흔드는 건 쓰다듬기가 아니다
  useEffect(() => {
    if (!ctrl || !active) return;
    const offs = [ctrl.on("grab", () => setHeld(true)), ctrl.on("drop", () => setHeld(false))];
    return () => offs.forEach((off) => off());
  }, [ctrl, active, setHeld]);
  const onMove = useCallback((e: React.MouseEvent) => {
    if (!ctrl || e.buttons) return; // 누른 채 움직이면 잡기(엔진)
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (ctrl.hit(e.clientX - r.left, e.clientY - r.top)) onBodyMove(e.movementX, e.movementY);
    else onBodyLeave();
  }, [ctrl, onBodyMove, onBodyLeave]);

  // 높이 손잡이: 위쪽 가장자리를 끌면 그만큼 키가 바뀐다(손을 뗄 때 저장)
  const onHandleDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY, startH = height;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => setStageHeight(placement, startH + (startY - ev.clientY), false);
    const up = (ev: PointerEvent) => {
      setStageHeight(placement, startH + (startY - ev.clientY), true);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  }, [height, placement, setStageHeight]);

  // 사이드바 방은 네코가 거실·마당에 가 있어도 같은 높이로 남는다(빈 방: 배경·방에 놓인 선물만). 거실 자리는 그때 없앤다
  if (!active && placement !== "sidebar") return null;
  return (
    <div className={`neko-slot neko-slot--${placement}`} style={{ height }}>
      <div
        className="neko-slot__handle"
        onPointerDown={onHandleDown}
        role="separator"
        aria-orientation="horizontal"
        aria-label="끌어서 고양이 자리 높이 조절"
        title="끌어서 높이 조절"
      />
      {/* 산책 중: 채팅 바 아래(가로로 김)는 '산책 중' 그림과 지도를 나란히, 사이드바 방(좁음)은 지도만.
          지도를 못 받으면(개발 빌드 등) 방에선 '산책 중' 그림으로 대신한다 */}
      {!active ? (
        <RoomGifts isDark={isDark} />
      ) : away ? (
        placement === "dock" ? (
          <div className="neko-slot__walk">
            <div className="neko-slot__away"><NekoAway /></div>
            <WalkMap className="neko-slot__map" walk={walk} isDark={isDark} />
          </div>
        ) : (
          <WalkMap className="neko-slot__map neko-slot__map--fill" walk={walk} isDark={isDark} fallback={<NekoAway />} />
        )
      ) : (
        <div
          ref={stageRef}
          className="neko-slot__stage"
          onMouseMove={onMove}
          onMouseLeave={onBodyLeave}
        />
      )}
      {active && !away && walk && (
        <button type="button" className="neko-slot__map-btn" onClick={() => setLastWalkOpen(true)} title="지난 산책 지도" aria-label="지난 산책 지도">
          <MapIcon size={13} strokeWidth={2} />
        </button>
      )}
      {lastWalkOpen && walk && <LastWalkModal walk={walk} isDark={isDark} onClose={() => setLastWalkOpen(false)} />}
      {decorMenu && active && !away && (
        <button
          type="button"
          className="neko-slot__tidy"
          style={{ left: decorMenu.x + 2, top: Math.max(2, decorMenu.y - 4) }}
          title="선물함으로 치우기"
          onClick={() => { useNekoGifts.getState().place(decorMenu.id, null); setDecorMenu(null); }}
        >
          정리
        </button>
      )}
    </div>
  );
}

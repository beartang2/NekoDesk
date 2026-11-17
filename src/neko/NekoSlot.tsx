import React, { useCallback, useLayoutEffect, useRef } from "react";
import { useTrackpadPet } from "../hooks/useTrackpadPet";
import { ensureNeko, nekoCanvas, useNekoController } from "./nekoHost";
import { useNekoStore, type NekoPlacement } from "./nekoStore";
import "./NekoSlot.css";

/**
 * 네코가 들어가는 자리. 앱엔 사이드바 패널 자리와 채팅 바 아래 자리 두 개가 있고,
 * 설정의 '채팅 바 아래로 내리기'에 맞는 자리 하나에만 캔버스가 붙는다(캔버스·엔진은 nekoHost 에 하나).
 * 위쪽 가장자리를 끌어서 높이를 바꾼다(고양이 크기가 높이를 따라간다).
 * 산책 중(away)엔 자리(높이)는 그대로 두고 고양이 대신 '산책 중'만 보인다. 엔진도 멈춘다.
 */
export function NekoSlot({ placement, onRubPet, away = false }: { placement: NekoPlacement; onRubPet: () => void; away?: boolean }) {
  const active = useNekoStore((s) => s.stage.placement === placement);
  const height = useNekoStore((s) => (placement === "sidebar" ? s.stage.sidebarH : s.stage.dockH));
  const setStageHeight = useNekoStore((s) => s.setStageHeight);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const ctrl = useNekoController();

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

  // 트랙패드 쓰다듬기: 고양이를 탭하면(엔진의 pet 이벤트) 쓰다듬기 모드를 켜고 끈다.
  // 모드에선 커서가 숨고 트랙패드를 문지르는 만큼 쓰다듬는다(useTrackpadPet).
  const rub = useCallback(() => {
    ctrl?.react("pet");
    onRubPet();
  }, [ctrl, onRubPet]);
  const { isPetting, togglePetting, onHoverMove, bindRef } = useTrackpadPet(rub);
  const setStageRef = useCallback((el: HTMLDivElement | null) => { stageRef.current = el; bindRef(el); }, [bindRef]);
  useLayoutEffect(() => {
    if (!ctrl || !active) return;
    const offs = [
      ctrl.on("pet", () => togglePetting()),
      // 두 번 탭('냥')이면 쓰다듬기 모드는 끈다
      ctrl.on("nyang", () => { if (document.pointerLockElement === stageRef.current) document.exitPointerLock(); }),
    ];
    return () => offs.forEach((f) => f());
  }, [ctrl, active, togglePetting]);
  // 쓰다듬기 모드(포인터 잠금)에선 클릭이 캔버스가 아니라 이 자리로 온다: 누르면 모드를 끈다
  const onLockedDown = useCallback(() => {
    if (document.pointerLockElement === stageRef.current) document.exitPointerLock();
  }, []);

  // 포인터 잠금이 막힌 환경의 폴백: 고양이 위에서 커서를 문질러도 쓰다듬는다(고양이 밖은 아님)
  const onMove = useCallback((e: React.MouseEvent) => {
    if (!ctrl || e.buttons) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (ctrl.hit(e.clientX - r.left, e.clientY - r.top)) onHoverMove(e);
  }, [ctrl, onHoverMove]);

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

  if (!active) return null;
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
      {away ? (
        <div className="neko-slot__away">산책 중</div>
      ) : (
        <div
          ref={setStageRef}
          className={`neko-slot__stage${isPetting ? " neko-slot__stage--petting" : ""}`}
          onMouseMove={onMove}
          onPointerDown={onLockedDown}
        />
      )}
    </div>
  );
}

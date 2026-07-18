import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * 트랙패드로 고양이를 쓰다듬는다. 가속도계를 대체한다(M4에서 root 데몬이 필요해 폐기).
 *
 * 두 경로:
 *  1) 고양이를 클릭 → Pointer Lock 진입. 커서가 사라지고 트랙패드 전체가
 *     쓰다듬기 패드가 된다. 손가락을 넓게 문지르면 그만큼 쓰다듬는다.
 *     다시 클릭하거나 Esc 로 빠져나온다.
 *  2) 폴백: 그냥 고양이 위에서 커서를 움직여도 쓰다듬어진다.
 *     (Pointer Lock 이 WKWebView 에서 막힐 때를 대비)
 *
 * 문지르는 동안 트랙패드가 실제로 진동한다(NSHapticFeedbackManager).
 */

const RUB_SPEED_THRESHOLD = 6;   // 평활된 이동량(px). 이 이상이면 "문지르는 중"
const PET_THROTTLE_MS = 320;     // 쓰다듬기 반응(하트·RPG) 최소 간격
const HAPTIC_THROTTLE_MS = 90;   // 햅틱 최소 간격 (너무 잦으면 뭉갬)

export function useTrackpadPet(onRub: () => void) {
  const targetRef = useRef<HTMLElement | null>(null);
  const [isPetting, setIsPetting] = useState(false);

  const speedRef = useRef(0);
  const lastPetRef = useRef(0);
  const lastHapticRef = useRef(0);
  const onRubRef = useRef(onRub);
  onRubRef.current = onRub;

  /** movementX/Y 를 받아 문지르기 세기를 판정하고 반응·햅틱을 낸다. */
  const feed = useCallback((dx: number, dy: number) => {
    const inst = Math.abs(dx) + Math.abs(dy);
    // 저역 통과: 순간 튐을 눌러 "쓰다듬는 결"만 남긴다
    speedRef.current = speedRef.current * 0.6 + inst * 0.4;
    if (speedRef.current < RUB_SPEED_THRESHOLD) return;

    const now = performance.now();
    if (now - lastHapticRef.current > HAPTIC_THROTTLE_MS) {
      lastHapticRef.current = now;
      // pattern 0 = generic (부드러운 촉감)
      invoke("haptic_feedback", { pattern: 0 }).catch(() => {});
    }
    if (now - lastPetRef.current > PET_THROTTLE_MS) {
      lastPetRef.current = now;
      onRubRef.current();
    }
  }, []);

  // 경로 1: Pointer Lock 상태에서의 문지르기 (document 레벨)
  useEffect(() => {
    function onLockChange() {
      setIsPetting(document.pointerLockElement === targetRef.current);
    }
    function onLockedMove(e: MouseEvent) {
      if (document.pointerLockElement !== targetRef.current) return;
      feed(e.movementX, e.movementY);
    }
    document.addEventListener("pointerlockchange", onLockChange);
    document.addEventListener("mousemove", onLockedMove);
    return () => {
      document.removeEventListener("pointerlockchange", onLockChange);
      document.removeEventListener("mousemove", onLockedMove);
    };
  }, [feed]);

  /** 고양이 클릭: 쓰다듬기 모드 토글. */
  const togglePetting = useCallback(() => {
    const el = targetRef.current;
    if (!el) return;
    if (document.pointerLockElement === el) {
      document.exitPointerLock();
    } else {
      // requestPointerLock 는 Promise 를 반환할 수도, 안 할 수도 있다(브라우저별)
      try {
        const r = el.requestPointerLock() as unknown as Promise<void> | undefined;
        r?.catch?.(() => {}); // 막히면 경로 2(hover)로 계속 동작
      } catch {
        /* 무시 — hover 폴백 */
      }
    }
  }, []);

  /** 경로 2 폴백: Pointer Lock 이 아닐 때, 고양이 위에서 움직이면 쓰다듬기. */
  const onHoverMove = useCallback((e: React.MouseEvent) => {
    if (document.pointerLockElement) return; // 잠긴 상태는 경로 1이 처리
    feed(e.movementX, e.movementY);
  }, [feed]);

  const bindRef = useCallback((el: HTMLElement | null) => {
    targetRef.current = el;
  }, []);

  return { isPetting, togglePetting, onHoverMove, bindRef };
}

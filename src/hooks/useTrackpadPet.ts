import { useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * 마우스로 고양이를 쓰다듬는다 — 고양이 몸 위에서 왔다 갔다 문지를 때만.
 *
 * 예전엔 고양이를 탭하면 포인터 잠금으로 트랙패드 전체가 쓰다듬기 패드가 됐고, 몸 위를 빠르게 지나가기만
 * 해도 쓰다듬기로 쳤다. 그래서 마우스가 스치기만 해도 하트가 떴다. 이제는 몸 위에서 결이 짧은 시간에
 * 두 번 뒤집혀야(가로든 세로든, 둥글게 문질러도) 쓰다듬기다 — 한 번 훑고 지나가면 0번이다.
 *
 * 문지르는 동안 트랙패드가 실제로 진동한다(NSHapticFeedbackManager).
 */

const STROKE_WINDOW_MS = 700;    // 이 안에 결이 두 번 뒤집혀야 쓰다듬기
const MIN_MOVE_PX = 2;           // 이보다 작은 움직임은 손 떨림 — 결로 안 친다
const PET_THROTTLE_MS = 320;     // 쓰다듬기 반응(하트·RPG) 최소 간격
const HAPTIC_THROTTLE_MS = 75;   // 햅틱 최소 간격 (너무 잦으면 뭉갬)

/**
 * 촉감의 세기. macOS 는 세기를 숫자로 못 정하고 패턴 셋 중에 고르는 게 전부다.
 * 약한 순서로 0=generic, 1=alignment(또렷한 탁), 2=levelChange(제일 묵직).
 */
const HAPTIC_PATTERN = 2;

export function useTrackpadPet(onRub: () => void) {
  const onRubRef = useRef(onRub);
  onRubRef.current = onRub;
  const lastPetRef = useRef(0);
  const lastHapticRef = useRef(0);
  /** 가로·세로 마지막 결(-1·1, 0 = 아직 모름)과 결이 뒤집힌 시각들. */
  const dirRef = useRef<[number, number]>([0, 0]);
  const turnsRef = useRef<number[]>([]);
  const heldRef = useRef(false);

  /** 몸을 벗어나면 결을 처음부터 센다. */
  const onBodyLeave = useCallback(() => {
    dirRef.current = [0, 0];
    turnsRef.current = [];
  }, []);

  /**
   * 잡혀 있는 동안(엔진 grab~drop)은 쓰다듬기가 아니다 — 고양이가 커서에 붙어 다녀 늘 몸 위라, 흔들면 결이 뒤집혀
   * 쓰다듬기로 쳤다. 잡을 때와 놓을 때 결을 처음부터 센다.
   */
  const setHeld = useCallback((on: boolean) => {
    heldRef.current = on;
    onBodyLeave();
  }, [onBodyLeave]);

  /** 고양이 몸 위에서 움직였을 때만 부른다(movementX/Y). */
  const onBodyMove = useCallback((dx: number, dy: number) => {
    if (heldRef.current) return;
    const now = performance.now();
    const dir = dirRef.current;
    [dx, dy].forEach((d, axis) => {
      if (Math.abs(d) < MIN_MOVE_PX) return;
      const s = Math.sign(d);
      if (dir[axis] && s !== dir[axis]) turnsRef.current.push(now);
      dir[axis] = s;
    });
    turnsRef.current = turnsRef.current.filter((t) => now - t < STROKE_WINDOW_MS);
    if (turnsRef.current.length < 2) return;

    if (now - lastHapticRef.current > HAPTIC_THROTTLE_MS) {
      lastHapticRef.current = now;
      invoke("haptic_feedback", { pattern: HAPTIC_PATTERN }).catch(() => {});
    }
    if (now - lastPetRef.current > PET_THROTTLE_MS) {
      lastPetRef.current = now;
      onRubRef.current();
    }
  }, []);

  return { onBodyMove, onBodyLeave, setHeld };
}

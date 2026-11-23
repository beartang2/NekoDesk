import { useSyncExternalStore } from "react";

/**
 * 폰 가로 화면(네코만 보기, lib/phone watchStandby)인가. 그동안 가려진 무거운 화면(메시지 목록·고양이가 없는 방·…)은 그리지
 * 않는다 — 가려 둔 캔버스도 GPU 메모리를 그대로 쥐고 있어, 오래 띄워 두면 iOS 가 화면 그림을 버려 흰 화면이 됐다.
 * 상태는 스토어·DB 에 있어 돌아오면 다시 그린다. 맥은 늘 false
 */
let on = false;
const subs = new Set<() => void>();

export function setStandby(v: boolean): void {
  if (on === v) return;
  on = v;
  subs.forEach((f) => f());
}

export const isStandby = () => on;

export const useStandby = () =>
  useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, () => on);

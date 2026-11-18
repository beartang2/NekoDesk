import { create } from "zustand";
import type { SchedulerLogEntry } from "./director/scheduler";
import type { NekoLayer } from "./director/types";

/**
 * 개발 빌드 '개발자' 설정 칸(NekoDevSection)이 부르는 것들. 콘솔(DevTools)로 다루던 훅(nekoWalk·__nekoDirector·
 * __nekoNeeds)을 앱 화면 스위치·버튼으로 옮겼다(사용자 원칙: 개발용 표시·트리거는 화면에, 기본은 꺼짐). 배포 빌드에선
 * 아무도 채우지 않는다.
 */
interface DevTools {
  /** 산책 바로 보내기(App). 나갔으면 "출발…", 아니면 못 나간 까닭 */
  walk: (() => Promise<string>) | null;
  /** 감독(useNekoDirector): 지금 층과 적용 기록 */
  director: { layer: () => NekoLayer | null; log: () => SchedulerLogEntry[] } | null;
  /** 캣타워 표시(화면 모드). 기본 꺼짐 — 켜야 Rust 가 창마다 까닭을 계산해 보낸다 */
  perchDebug: boolean;
}

export const useDevTools = create<DevTools>(() => ({ walk: null, director: null, perchDebug: false }));

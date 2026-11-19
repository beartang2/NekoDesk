import { useNekoApp } from "./director/stores";

/**
 * 산책과 '앱을 쓰는 중'(App). 앱을 만지면(lastActiveAt: 입력·클릭·스크롤·밥·놀이) 졸음 타이머만 다시 건다 — 감독이 재우는 때
 * (sleepyMs)부터 졸고(onIdle(true)), 다시 쓰면 깬다(onIdle(false)). 산책 중인 네코가 서둘러 오는 건 사용자가 부를 때(callHome)만이다
 * (onCall). 예전엔 창을 누르거나 스크롤만 해도 1–2분 안에 돌아와 산책이 늘 끊겼다. 끄는 함수를 돌려준다
 */
export function watchWalkIdle(o: { sleepyMs: number; onIdle: (idle: boolean) => void; onCall: () => void }): () => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  const arm = (at: number) => {
    clearTimeout(t);
    o.onIdle(false);
    t = setTimeout(() => o.onIdle(true), at + o.sleepyMs - performance.now());
  };
  arm(useNekoApp.getState().lastActiveAt);
  const off = useNekoApp.subscribe((s, p) => {
    if (s.lastActiveAt !== p.lastActiveAt) arm(s.lastActiveAt);
    if (s.calledAt !== p.calledAt) o.onCall();
  });
  return () => { clearTimeout(t); off(); };
}

/**
 * 다른 기기가 앞인가(그 기기가 이 기기보다 나중에 쓰였다 — neko/presence 가 정해 알린다). 숨은 게이지(director/needsStore)가
 * 앞 기기 것을 따를 때 본다. presence 를 바로 가져오면 감독 스토어·설정까지 딸려 와, 의존 없는 작은 칸으로 따로 둔다
 */
let follow = false;
const subs = new Set<() => void>();

export const following = (): boolean => follow;

export function setFollowing(v: boolean): void {
  if (v === follow) return;
  follow = v;
  subs.forEach((f) => f());
}

/** 앞·뒤가 바뀔 때 */
export function onLead(f: () => void): () => void {
  subs.add(f);
  return () => { subs.delete(f); };
}

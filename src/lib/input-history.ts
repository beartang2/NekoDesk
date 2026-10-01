/**
 * 입력창의 ↑/↓ 기록 이동 — 터미널과 같은 규칙.
 *
 * 순수 함수로 떼어놨다. 인덱스를 한 칸 옮기는 규칙에 경계가 네 개(빈 기록, 가장
 * 오래된 것, 가장 최근, 기록 밖)라 컴포넌트 안에 두면 눈으로 확인할 수가 없다.
 */

/** 지금 보고 있는 위치. null = 기록을 안 보는 중(사용자가 쓰던 초안). */
export type HistoryPos = number | null;

/** 기록은 오래된 것부터 들어온다. 위치는 **뒤에서** 몇 번째다(0 = 가장 최근). */
function at(history: string[], pos: number): string {
  return history[history.length - 1 - pos] ?? "";
}

/**
 * ↑(-1) / ↓(+1) 한 칸 이동한 결과. `null` 이면 되살릴 게 없다는 뜻이고,
 * 호출자는 키를 가로채지 말고 커서 이동에 맡겨야 한다.
 *
 * - 가장 오래된 것에서 ↑ 는 제자리다. 넘어가서 빈 칸이 되면 기록을 잃은 줄 안다.
 * - 가장 최근에서 ↓ 는 `draft` 로 돌아온다. 기록을 뒤지다 쓰던 걸 잃으면 안 된다.
 */
export function historyStep(
  history: string[],
  pos: HistoryPos,
  dir: -1 | 1,
  draft: string
): { pos: HistoryPos; text: string } | null {
  if (history.length === 0) return null;
  if (pos === null) {
    // 기록 밖에서 ↓ 는 할 일이 없다 — 아래로는 초안이 끝이다.
    return dir === 1 ? null : { pos: 0, text: at(history, 0) };
  }
  const next = pos + (dir === -1 ? 1 : -1);
  if (next < 0) return { pos: null, text: draft };
  if (next >= history.length) return { pos, text: at(history, pos) };
  return { pos: next, text: at(history, next) };
}

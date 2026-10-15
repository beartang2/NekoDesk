/**
 * 트랙패드 스와이프 한 번 = 한 칸.
 *
 * 손을 떼도 관성으로 wheel 이 한참 더 온다. 그래서 한 칸 넘긴 뒤엔 잠그고, 아래 중 하나면 푼다.
 *   - wheel 이 idleMs 동안 끊김 (손을 뗐고 관성도 끝남)
 *   - 방향이 바뀜 (관성은 방향을 바꾸지 않는다)
 *   - 세기가 꼭대기의 DECAY 배 아래로 떨어졌다가 연달아 두 번 커짐 (관성은 약해지기만 한다)
 *
 * 세게 밀다 손을 떼면 손가락이 잠깐 느려졌다가 관성이 한 번 튄다. 한 번 커지고 바로
 * 잦아드는 그 튐을 새 손짓으로 보면 두 칸 넘어가서, 연달아 커지는 것만 손짓으로 친다.
 * 넘긴 직후 GUARD_MS 동안은 아예 풀지 않는다 — 사람이 그 안에 다시 밀 수는 없다.
 *
 * 예전엔 끊길 때만 풀어서, 커서를 둔 채 연달아 밀면 앞 손짓의 관성 꼬리에 다음 손짓이
 * 이어 붙어 끊김이 없었고, 한 번밖에 안 넘어갔다.
 *
 * ponytail: 브라우저 wheel 이벤트엔 손가락/관성 구분(phase)이 없어 세기 모양으로 짐작한다.
 * 손이 아주 느리게 다시 밀기 시작하면 풀림이 한 박자 늦을 수 있다 — 그땐 끊김이 푼다.
 */

/** 꼭대기의 이 비율 아래로 떨어져야 관성 꼬리로 본다. 미는 동안의 흔들림은 이보다 크다. */
const DECAY = 0.35;
/** 꼬리에서 다시 커질 때 최소 세기(px). 꼬리의 1~3px 흔들림에 풀리지 않게. */
const RISE_MIN = 6;
/** 넘긴 뒤 이만큼은 커져도 풀지 않는다. 손을 뗄 때의 튐이 이 안에 온다. */
const GUARD_MS = 250;

export function createSwipeStepper(threshold: number, idleMs: number) {
  let sum = 0;
  let locked = false;
  let lastAt = -Infinity;
  let lastAbs = 0;
  let lastSign = 0;
  let peak = 0;
  let trough = Infinity;
  let decayed = false;
  let rises = 0;
  let lockedAt = 0;

  const unlock = () => {
    locked = false;
    sum = 0;
  };

  /** wheel 한 건을 넣으면 넘길 방향(1 다음, -1 이전)을, 아직이면 0 을 돌려준다. */
  return (delta: number, now: number): -1 | 0 | 1 => {
    const abs = Math.abs(delta);
    const sign = Math.sign(delta);

    if (now - lastAt > idleMs) unlock();
    else if (locked) {
      if (sign && lastSign && sign !== lastSign) unlock();
      else if (!decayed) {
        peak = Math.max(peak, abs);
        if (abs <= peak * DECAY) decayed = true;
      }
      if (locked && decayed) {
        trough = Math.min(trough, abs);
        rises = abs > lastAbs && abs >= Math.max(RISE_MIN, trough * 2) ? rises + 1 : 0;
        if (rises >= 2 && now - lockedAt >= GUARD_MS) unlock();
      }
    }
    lastAt = now;
    lastAbs = abs;
    if (sign) lastSign = sign;

    if (locked) return 0;
    sum += delta;
    if (Math.abs(sum) < threshold) return 0;

    locked = true;
    lockedAt = now;
    rises = 0;
    peak = abs;
    trough = Infinity;
    decayed = false;
    const dir = sum > 0 ? 1 : -1;
    sum = 0;
    return dir;
  };
}

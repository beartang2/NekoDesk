/**
 * 그림판 약한 손떨림 보정(사용자: 폰·맥 그림판이 짜글짜글하게 그려지지 않게, 조금만).
 *
 * - 펜 끝이 입력 점을 지수 평균으로 따라간다(한 번에 남은 거리의 k 만큼). k 가 클수록 손에 바짝 붙는다 — 0.55 는 60Hz 입력에서
 *   두세 칸(30ms 안팎)이면 따라붙어 늦게 따라온다는 느낌이 거의 없고, 손끝·트랙패드의 1~2px 떨림은 반쯤 눌린다.
 * - 이어 그릴 땐 펜 끝들의 가운데점 사이를 펜 끝을 조절점으로 한 2차 곡선으로 잇는다 — 꺾인 직선 마디가 안 보인다.
 * - 손을 떼면 남은 곳에서 마지막 입력 점까지 이어 그린다(빠르게 그은 짧은 선도 끝까지 간다). 점 찍기는 그리는 쪽이 따로 한다.
 */
export type Pt = { x: number; y: number };
/** 그릴 조각: from 에서 ctrl 을 조절점으로 to 까지(2차 곡선) */
export type Seg = { from: Pt; ctrl: Pt; to: Pt };

export const SMOOTH_K = 0.55;

const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function createSmoother(k = SMOOTH_K) {
  let pen: Pt | null = null, from: Pt | null = null, last: Pt | null = null;
  return {
    /** 획 시작(누른 점) */
    start(p: Pt): void { pen = p; from = p; last = p; },
    /** 새 입력 점 → 이번에 그릴 조각. 획 밖이면 null */
    move(p: Pt): Seg | null {
      if (!pen || !from) return null;
      last = p;
      const next = lerp(pen, p, k), to = lerp(pen, next, 0.5);
      const seg = { from, ctrl: pen, to };
      pen = next; from = to;
      return seg;
    },
    /** 획 끝: 남은 곳에서 마지막 입력 점까지. 남은 게 없으면(누르고 떼기만) null */
    end(): Seg | null {
      const seg = pen && from && last && (Math.abs(last.x - from.x) > 0.01 || Math.abs(last.y - from.y) > 0.01) ? { from, ctrl: pen, to: last } : null;
      pen = from = last = null;
      return seg;
    },
  };
}

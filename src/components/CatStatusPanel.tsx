import type { ReactNode } from "react";
import "./CatStatusPanel.css";

interface Props {
  dayCount: number;
  hunger: number;
  play: number;
  canFeed: boolean;
  feedCountToday: number;
  isCompacting?: boolean;
  onFeed: () => void;
  onPlay: () => void;
  /** 첫 줄 오른쪽(컨텍스트 쓴 양 / 한도) */
  ctx?: ReactNode;
}

/**
 * 네코 방 아래 얇은 띠. 첫 줄 DAY 와 컨텍스트, 둘째 줄 밥·놀이 게이지 — 게이지 칸이 곧 버튼이다(밥 주기·놀아주기).
 * 네코가 거실·마당에 가 있어도 사이드바 같은 자리에 남는다.
 */
export function CatStatusPanel({ dayCount, hunger, play, canFeed, isCompacting = false, onFeed, onPlay, ctx }: Props) {
  const hungerLevel = hunger < 10 ? "critical" : hunger < 30 ? "low" : "normal";
  const playLevel = play < 20 ? "low" : "normal";

  return (
    <div className="cat-status">
      <div className="cat-status__top">
        <span className="cat-status__day">Day {dayCount}</span>
        {ctx && <span className="cat-status__ctx" title="이 대화가 쓴 컨텍스트 / 모델 한도">{ctx}</span>}
      </div>
      <div className="cat-status__meters">
        <button
          type="button"
          className="cat-meter"
          onClick={onFeed}
          disabled={!canFeed || isCompacting}
          title={`${isCompacting ? "대화 요약 중..." : "밥 주기 — 대화를 요약해서 컨텍스트를 정리해요"}\n배고픔 ${Math.round(hunger)}/100 — 대화가 길수록 배고파요`}
        >
          <span className="cat-meter__icon" aria-hidden="true">🍚</span>
          <span className="cat-gauge__track">
            <span className={`cat-gauge__fill cat-gauge__fill--hunger cat-gauge__fill--${hungerLevel}`} style={{ width: `${hunger}%` }} />
          </span>
          <span className="cat-meter__text">{isCompacting ? "냠냠..." : "밥 주기"}</span>
        </button>
        <button type="button" className="cat-meter" onClick={onPlay} title={`놀아주기\n놀이 ${Math.round(play)}/100`}>
          <span className="cat-meter__icon" aria-hidden="true">🎾</span>
          <span className="cat-gauge__track">
            <span className={`cat-gauge__fill cat-gauge__fill--play cat-gauge__fill--${playLevel}`} style={{ width: `${play}%` }} />
          </span>
          <span className="cat-meter__text">놀아주기</span>
        </button>
      </div>
    </div>
  );
}

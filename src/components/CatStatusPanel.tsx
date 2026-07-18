import React from "react";
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
}

export function CatStatusPanel({
  dayCount,
  hunger,
  play,
  canFeed,
  feedCountToday,
  isCompacting = false,
  onFeed,
  onPlay,
}: Props) {
  const hungerLevel = hunger < 10 ? "critical" : hunger < 30 ? "low" : "normal";
  const playLevel = play < 20 ? "low" : "normal";

  return (
    <div className="cat-status">
      <div className="cat-status__day">Day {dayCount}</div>

      <div className="cat-status__gauges">
        <div className="cat-gauge" title={`배고픔 ${Math.round(hunger)}/100 — 대화가 길수록 배고파요`}>
          <span className="cat-gauge__icon">🍚</span>
          <div className="cat-gauge__track">
            <div
              className={`cat-gauge__fill cat-gauge__fill--hunger cat-gauge__fill--${hungerLevel}`}
              style={{ width: `${hunger}%` }}
            />
          </div>
        </div>

        <div className="cat-gauge" title={`놀이 ${Math.round(play)}/100`}>
          <span className="cat-gauge__icon">🎾</span>
          <div className="cat-gauge__track">
            <div
              className={`cat-gauge__fill cat-gauge__fill--play cat-gauge__fill--${playLevel}`}
              style={{ width: `${play}%` }}
            />
          </div>
        </div>
      </div>

      <div className="cat-status__btns">
        <button
          className="cat-status__btn"
          onClick={onFeed}
          disabled={!canFeed || isCompacting}
          title={isCompacting ? "대화 요약 중..." : "밥 주기 — 대화를 요약해서 컨텍스트를 정리해요"}
        >
          <span className="cat-status__btn-icon">🍚</span>
          <span className="cat-status__btn-text">{isCompacting ? "냠냠..." : "밥 주기"}</span>
        </button>
        <button className="cat-status__btn" onClick={onPlay} title="놀아주기">
          <span className="cat-status__btn-icon">🎾</span>
          <span className="cat-status__btn-text">놀아주기</span>
        </button>
      </div>
    </div>
  );
}

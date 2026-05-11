import React from "react";
import "./CatStatusPanel.css";

interface Props {
  dayCount: number;
  hunger: number;
  play: number;
  canFeed: boolean;
  feedCountToday: number;
  onFeed: () => void;
  onPlay: () => void;
}

export function CatStatusPanel({
  dayCount,
  hunger,
  play,
  canFeed,
  feedCountToday,
  onFeed,
  onPlay,
}: Props) {
  const hungerLevel = hunger < 10 ? "critical" : hunger < 30 ? "low" : "normal";
  const playLevel = play < 20 ? "low" : "normal";

  return (
    <div className="cat-status">
      <div className="cat-status__day">Day {dayCount}</div>

      <div className="cat-status__gauges">
        <div className="cat-gauge" title={`배고픔 ${Math.round(hunger)}/100`}>
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
          disabled={!canFeed}
          title={canFeed ? "밥 주기" : `오늘 ${feedCountToday}/3회 완료`}
        >
          밥 주기 {!canFeed && `(${feedCountToday}/3)`}
        </button>
        <button className="cat-status__btn" onClick={onPlay} title="놀아주기">
          놀아주기
        </button>
      </div>
    </div>
  );
}

import React from "react";
import { ArrowRight } from "lucide-react";
import { NekoPortrait } from "../neko/NekoPortrait";
import "./ChatEmptyState.css";

/**
 * 대화가 하나도 없을 때의 화면.
 *
 * 예전에는 아무것도 없는 빈 칸이었다. 빈 캔버스는 "뭘 할 수 있는지" 를 알려주지
 * 않아서, 처음 여는 사람에게는 그냥 고장난 화면처럼 보인다. 고양이가 무엇을
 * 할 수 있는지 몇 개만 보여주고, 누르면 바로 그 대화를 시작한다.
 */

/** 실제로 지금 붙어 있는 툴로 처리되는 것들만 고른다. 못 하는 걸 권하면 안 된다. */
const SUGGESTIONS = [
  { icon: "📋", label: "오늘 할 일이랑 일정 정리해줘" },
  { icon: "🔍", label: "이번 달 AI 뉴스 찾아서 요약해줘" },
  { icon: "🎵", label: "음악 틀어줘" },
  { icon: "🎮", label: "끝말잇기 하자" },
];

/** 버블마다 조금씩 다른 기울기. 네 개가 손으로 흩어 놓은 것처럼 보인다. */
const TILT = [-4, 3, -3, 4];

export function ChatEmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="empty-state">
      <h2 className="empty-state__title">뭐 도와줄까?</h2>
      <p className="empty-state__sub">
        할 일·일정 정리, 웹 검색, 파일 다루기, 노래 듣기 등을 부탁할 수 있어.
      </p>

      <div className="empty-state__chips">
        {SUGGESTIONS.map((s, i) => (
          <button
            key={s.label}
            className="empty-state__chip"
            /* 버블이 하나씩 튀어 들어온다(reactbits 의 BubbleMenu). 기울기는 저마다
               다르고, 글자는 버블보다 한 박자 늦게 올라온다. */
            style={{
              "--tilt": `${TILT[i % TILT.length]}deg`,
              "--pop-delay": `${120 + i * 110}ms`,
            } as React.CSSProperties}
            onClick={() => onPick(s.label)}
          >
            <span className="empty-state__chip-icon" aria-hidden="true">{s.icon}</span>
            <span className="empty-state__chip-label">{s.label}</span>
            <ArrowRight className="empty-state__chip-arrow" size={13} strokeWidth={2.25} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
}

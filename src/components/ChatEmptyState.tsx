import { CAT_VARIANTS } from "../cat/spriteData";
import { useCatStore } from "../stores/catStore";
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
  { icon: "🔍", label: "이번 주 AI 뉴스 찾아서 요약해줘" },
  { icon: "🎵", label: "음악 틀어줘" },
  { icon: "🎮", label: "끝말잇기 하자" },
];

export function ChatEmptyState({ onPick }: { onPick: (text: string) => void }) {
  const variantId = useCatStore((s) => s.variantId);
  const variant = CAT_VARIANTS.find((v) => v.id === variantId) ?? CAT_VARIANTS[0];

  return (
    <div className="empty-state">
      <div
        className="empty-state__mark"
        style={{ background: variant.swatchCss }}
        aria-hidden="true"
      />
      <h2 className="empty-state__title">뭐 도와줄까?</h2>
      <p className="empty-state__sub">
        할 일·일정 정리, 웹 검색, 파일 다루기, 맥 조작까지 부탁할 수 있어.
      </p>

      <div className="empty-state__chips">
        {SUGGESTIONS.map((s, i) => (
          <button
            key={s.label}
            className="empty-state__chip"
            /* 칩이 하나씩 들어오면 목록이 "생겨나는" 느낌이 된다. 첫 화면에서
               한 번만 도는 애니메이션이라 매일 쓰기에 부담되지 않는다. */
            style={{ animationDelay: `${60 + i * 45}ms` }}
            onClick={() => onPick(s.label)}
          >
            <span className="empty-state__chip-icon" aria-hidden="true">{s.icon}</span>
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}

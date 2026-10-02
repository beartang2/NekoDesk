import React, { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { getAnimation, type AnimDef } from "../cat/spriteData";
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

/** 첫 화면의 고양이. 사이드바의 그 아이가 그대로 앉아서 꼬리를 흔든다. */
const MARK_SIZE = 32 * 2;

/**
 * 스프라이트 한 줄을 캔버스에 돌린다. `once` 면 마지막 칸에서 멈추고 `onDone` 을
 * 한 번 부른다(부팅 화면). 아니면 계속 돈다.
 */
export function SpriteCat({
  anim,
  size = MARK_SIZE,
  once = false,
  onDone,
}: {
  anim: AnimDef;
  size?: number;
  once?: boolean;
  onDone?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frameIdx, setFrameIdx] = useState(0);
  const count = anim.frames.length;
  const doneRef = useRef(false);

  // 부르는 쪽이 매번 새 anim 객체를 넘겨도 처음부터 다시 돌지 않게 값으로 비교한다.
  useEffect(() => {
    const id = setInterval(
      () => setFrameIdx((i) => (once ? Math.min(i + 1, count - 1) : (i + 1) % count)),
      anim.interval
    );
    return () => clearInterval(id);
  }, [anim.src, anim.interval, count, once]);

  useEffect(() => {
    if (once && frameIdx === count - 1 && !doneRef.current) {
      doneRef.current = true;
      onDone?.();
    }
  }, [once, frameIdx, count, onDone]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    const image = new Image();
    image.src = anim.src;
    const draw = () => {
      const frame = anim.frames[frameIdx] ?? anim.frames[0];
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, frame.x, frame.y, frame.w, frame.h, 0, 0, canvas.width, canvas.height);
    };
    if (image.complete) draw();
    else image.addEventListener("load", draw);
    return () => image.removeEventListener("load", draw);
  }, [anim.src, frameIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <canvas
      ref={canvasRef}
      className="empty-state__cat"
      // 화면 배율만큼 더 촘촘히 그려야 픽셀이 뭉개지지 않는다(고양이 패널과 같은 방식).
      width={size * 2}
      height={size * 2}
      style={{ width: size, height: size }}
      aria-hidden="true"
    />
  );
}

export function EmptyStateCat() {
  const variantId = useCatStore((s) => s.variantId);
  return <SpriteCat anim={getAnimation("idle", variantId)} />;
}

/** 버블마다 조금씩 다른 기울기. 네 개가 손으로 흩어 놓은 것처럼 보인다. */
const TILT = [-4, 3, -3, 4];

export function ChatEmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="empty-state">
      <EmptyStateCat />
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

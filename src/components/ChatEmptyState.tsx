import React, { useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { getAnimation } from "../cat/spriteData";
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

/**
 * 글자가 하나씩 흐릿한 채 내려앉는 제목(reactbits 의 BlurText 와 같은 결).
 *
 * 공백은 쪼개지 않고 그대로 둔다 — 나눠 놓으면 줄바꿈 자리가 어긋난다.
 */
function BlurText({ text, className, delay = 45, start = 0 }: {
  text: string;
  className?: string;
  delay?: number;
  start?: number;
}) {
  return (
    <span className={className} aria-label={text}>
      {[...text].map((ch, i) => (
        <span
          key={i}
          className="blur-char"
          style={{ animationDelay: `${start + i * delay}ms` }}
          aria-hidden="true"
        >
          {ch === " " ? "\u00a0" : ch}
        </span>
      ))}
    </span>
  );
}

/** 첫 화면의 고양이. 사이드바의 그 아이가 그대로 앉아서 꼬리를 흔든다. */
const MARK_SIZE = 32 * 2;

function EmptyStateCat() {
  const variantId = useCatStore((s) => s.variantId);
  const anim = getAnimation("idle", variantId);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frameIdx, setFrameIdx] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrameIdx((i) => (i + 1) % anim.frames.length), anim.interval);
    return () => clearInterval(id);
  }, [anim.frames.length, anim.interval]);

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
  }, [anim, frameIdx]);

  return (
    <canvas
      ref={canvasRef}
      className="empty-state__cat"
      // 화면 배율만큼 더 촘촘히 그려야 픽셀이 뭉개지지 않는다(고양이 패널과 같은 방식).
      width={MARK_SIZE * 2}
      height={MARK_SIZE * 2}
      style={{ width: MARK_SIZE, height: MARK_SIZE }}
      aria-hidden="true"
    />
  );
}

/** 커서가 있는 자리에 옅은 빛이 따라다닌다(reactbits 의 SpotlightCard 와 같은 방식). */
function trackSpotlight(e: React.MouseEvent<HTMLElement>) {
  const box = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty("--mouse-x", `${e.clientX - box.left}px`);
  e.currentTarget.style.setProperty("--mouse-y", `${e.clientY - box.top}px`);
}

export function ChatEmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="empty-state">
      <EmptyStateCat />
      <h2 className="empty-state__title">
        <BlurText text="뭐 도와줄까?" start={120} />
      </h2>
      <p className="empty-state__sub">
        <BlurText
          text="할 일·일정 정리, 웹 검색, 파일 다루기, 맥 조작까지 부탁할 수 있어."
          delay={12}
          start={320}
        />
      </p>

      <div className="empty-state__chips">
        {SUGGESTIONS.map((s, i) => (
          <button
            key={s.label}
            className="empty-state__chip"
            /* 칩이 하나씩 들어오면 목록이 "생겨나는" 느낌이 된다. 첫 화면에서
               한 번만 도는 애니메이션이라 매일 쓰기에 부담되지 않는다. */
            style={{ animationDelay: `${560 + i * 80}ms` }}
            onMouseMove={trackSpotlight}
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

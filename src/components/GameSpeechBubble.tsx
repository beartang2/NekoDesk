import React, { useLayoutEffect, useRef } from "react";

/**
 * 게임 중 고양이가 하는 말.
 *
 * 예전엔 고양이 패널 위에 겹쳐 띄워서 고양이와 밥·놀이 게이지를 가렸다. 이제는
 * 그림판과 고양이 사이에 제 자리를 차지한다 — 게임 중 그림판은 남는 높이를 받으므로
 * (RightPanel 의 `panel-card--game`) 말풍선이 생기면 그림판이 그만큼 줄어든다.
 *
 * 꼬리는 고양이를 가리킨다. 고양이의 가로 위치는 사이드바 폭에 따라 달라지므로
 * (게임을 켜면 220 → 400px) 고정값을 쓸 수 없어 실제 좌표를 재서 맞춘다.
 */
export function GameSpeechBubble({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => {
      // 네코가 채팅 바 아래에 있으면 사이드바엔 없다 — 꼬리는 기본 자리
      const cat = el.closest(".sidebar")?.querySelector<HTMLCanvasElement>("canvas.neko-canvas");
      if (!cat) return;
      const bubble = el.getBoundingClientRect();
      const box = cat.getBoundingClientRect();
      // 네코는 무대를 걸어 다닌다. 처음 서는 자리(무대 폭의 45%)를 가리킨다.
      const bodyCenter = box.left + box.width * 0.45;
      el.style.setProperty("--tail-x", `${Math.round(bodyCenter - bubble.left)}px`);
    };

    update();
    const sidebar = el.closest(".sidebar");
    if (!sidebar) return;
    const observer = new ResizeObserver(update);
    observer.observe(sidebar);
    return () => observer.disconnect();
  }, [text]);

  return (
    <div className="cat-game-bubble" ref={ref}>
      {text}
    </div>
  );
}

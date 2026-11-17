import { useEffect, useRef, useState } from "react";
import { drawShape, shapeBounds, type GiftShape } from "./engine/gift-shape";
import { GIFT_DND, useNekoGifts } from "./gifts";
import "./NekoGiftBox.css";

/** 선물 그림. 무대와 같은 그리기 함수(drawShape)라 그림체가 같다. */
function GiftThumb({ shape, size = 56 }: { shape: GiftShape; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const b = shapeBounds(shape), u = (size * 0.78) / Math.max(b.w, b.h);
    drawShape(ctx, shape, size / 2 - ((b.x0 + b.x1) / 2) * u, size / 2 + (b.h * u) / 2, u, 3 * dpr);
  }, [shape, size, dpr]);
  return <canvas ref={ref} width={size * dpr} height={size * dpr} style={{ width: size, height: size }} aria-hidden />;
}

/** 접어 둘 때 보이는 칸 수 — 설정 폭에서 두 줄 */
const FOLD = 8;
const DAY = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" });

/**
 * 선물함(설정 › 고양이). 산책에서 주워 온 물건이 쌓이고, 바닥에 놓거나 치운다. 설계: docs/neko-gifts.md §3.
 * 놓은 자리는 무대 폭 비율이라 사이드바·아래 띠 어디서나 같은 자리에 보인다.
 */
export function NekoGiftBox() {
  const gifts = useNekoGifts((s) => s.gifts);
  const place = useNekoGifts((s) => s.place);
  const [all, setAll] = useState(false);
  const list = [...gifts].reverse();
  const shown = all ? list : list.slice(0, FOLD);
  useEffect(() => { void useNekoGifts.getState().load(); }, []);

  return (
    <div className="neko-gifts">
      <div className="neko-gifts__head">
        <span>선물함</span>
        <span className="neko-gifts__count">{gifts.length}</span>
      </div>
      {gifts.length === 0 ? (
        <p className="settings-section__desc">아직 받은 선물이 없어. 네코가 산책에서 주워 오면 여기 쌓여.</p>
      ) : (
        <>
        <p className="settings-section__desc">칸을 네코 자리로 끌어다 놓아. 높이 두면 벽에 걸리고, 놓인 걸 우클릭하면 치울 수 있어.</p>
        <ul className="neko-gifts__grid">
          {shown.map((g) => (
            <li
              key={g.id}
              className={`neko-gifts__item${g.placed ? " neko-gifts__item--placed" : ""}`}
              title={`${g.body || g.title}\n${DAY.format(new Date(g.at))}에 받음${g.placed ? " · 무대에 놓여 있어" : ""}`}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(GIFT_DND, g.id);
                e.dataTransfer.effectAllowed = "move";
                const cv = e.currentTarget.querySelector("canvas");
                if (cv) e.dataTransfer.setDragImage(cv, cv.clientWidth / 2, cv.clientHeight / 2);
                // 설정은 메뉴 창(덮개) 안이라 네코 자리가 가려져 있다: 끄는 동안 덮개를 비켜 놓을 수 있게.
                // dragstart 안에서 바로 바꾸면 끌기가 취소되는 엔진이 있어 다음 틱에
                setTimeout(() => document.body.classList.add("neko-gift-dragging"));
              }}
              onDragEnd={() => document.body.classList.remove("neko-gift-dragging")}
            >
              <GiftThumb shape={g.shape} />
              <span className="neko-gifts__title">{g.title}</span>
              <button type="button" className="settings-btn neko-gifts__btn" onClick={() => place(g.id, g.placed ? null : "auto")}>
                {g.placed ? "치우기" : "바닥에 놓기"}
              </button>
            </li>
          ))}
        </ul>
        {list.length > FOLD && (
          <button type="button" className="settings-btn neko-gifts__more" onClick={() => setAll(!all)}>
            {all ? "접기" : `${list.length - FOLD}개 더 보기`}
          </button>
        )}
        </>
      )}
    </div>
  );
}

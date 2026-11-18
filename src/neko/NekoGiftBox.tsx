import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { drawShape, shapeBounds, type GiftShape } from "./engine/gift-shape";
import { GIFT_DROP, useNekoGifts, type GiftDrop } from "./gifts";
import "./NekoCustomizeModal.css";
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

/**
 * 선물 칸 끌기. HTML 끌어 놓기(draggable)는 WebKit 에서 무대에 잘 안 놓이고 끄는 그림에 둘레 글자가 잘려 묻어나서
 * 포인터로 직접 끈다: 그림만 복사해 손가락을 따라가게 하고, 놓은 자리 밑에 무대가 있으면 GIFT_DROP 을 보낸다.
 * 끄는 동안 body 의 neko-gift-dragging 이 선물함 창과 설정 덮개를 흐리게 비킨다(NekoGiftBox.css).
 */
function dragGift(e: React.PointerEvent<HTMLElement>, id: string) {
  if (e.button !== 0 || (e.target as Element).closest("button")) return;
  const cell = e.currentTarget, src = cell.querySelector("canvas");
  if (!src) return;
  e.preventDefault(); // 글자 선택 막기
  cell.setPointerCapture(e.pointerId);
  const sx = e.clientX, sy = e.clientY, half = src.clientWidth / 2;
  let ghost: HTMLCanvasElement | null = null, over: Element | null = null;
  const stageAt = (x: number, y: number) =>
    document.elementsFromPoint(x, y).map((el) => el.closest(".neko-slot__stage")).find(Boolean) ?? null;

  const move = (ev: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return; // 누르기만 한 건 끌기가 아니다
      ghost = document.createElement("canvas");
      ghost.width = src.width;
      ghost.height = src.height;
      ghost.getContext("2d")!.drawImage(src, 0, 0);
      ghost.className = "neko-gifts__ghost";
      ghost.style.width = ghost.style.height = `${half * 2}px`;
      document.body.appendChild(ghost);
      document.body.classList.add("neko-gift-dragging");
    }
    ghost.style.transform = `translate(${ev.clientX - half}px, ${ev.clientY - half}px)`;
    const s = stageAt(ev.clientX, ev.clientY);
    if (s !== over) {
      over?.classList.remove("is-gift-over");
      s?.classList.add("is-gift-over");
      over = s;
    }
  };
  const end = (ev: PointerEvent) => {
    cell.removeEventListener("pointermove", move);
    cell.removeEventListener("pointerup", end);
    cell.removeEventListener("pointercancel", end);
    if (!ghost) return;
    ghost.remove();
    document.body.classList.remove("neko-gift-dragging");
    over?.classList.remove("is-gift-over");
    if (ev.type === "pointerup" && over) over.dispatchEvent(new CustomEvent<GiftDrop>(GIFT_DROP, { detail: { id, x: ev.clientX, y: ev.clientY } }));
  };
  cell.addEventListener("pointermove", move);
  cell.addEventListener("pointerup", end);
  cell.addEventListener("pointercancel", end);
}

const DAY = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" });

/**
 * 선물함(설정 › 고양이). 설정엔 개수와 '열기'만 두고, 목록은 창으로 띄운다 — 선물은 100개까지 쌓여 설정 화면을 밀어낸다.
 * 설계: docs/neko-gifts.md §3. 놓은 자리는 무대 폭 비율이라 사이드바·아래 띠 어디서나 같은 자리에 보인다.
 */
export function NekoGiftBox() {
  const count = useNekoGifts((s) => s.gifts.length);
  const [open, setOpen] = useState(false);
  useEffect(() => { void useNekoGifts.getState().load(); }, []);

  return (
    <div className="neko-gifts">
      <div className="neko-gifts__head">
        <span>선물함</span>
        <span className="neko-gifts__count">{count}</span>
        {count > 0 && <button type="button" className="settings-btn neko-gifts__open" onClick={() => setOpen(true)}>열기</button>}
      </div>
      {count === 0 && <p className="settings-section__desc">아직 받은 선물이 없어. 네코가 산책에서 주워 오면 여기 쌓여.</p>}
      {open && <NekoGiftModal onClose={() => setOpen(false)} />}
    </div>
  );
}

/** 선물함 창. 꾸미기 창과 같은 틀(neko-cz)을 쓴다. 칸을 끄는 동안은 창과 설정이 함께 비켜 네코 자리에 놓을 수 있다. */
function NekoGiftModal({ onClose }: { onClose: () => void }) {
  const gifts = useNekoGifts((s) => s.gifts);
  const place = useNekoGifts((s) => s.place);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return createPortal(
    <div className="neko-cz__backdrop neko-gifts-layer" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="neko-cz neko-gifts-modal" role="dialog" aria-modal="true" aria-labelledby="neko-gifts-title">
        <header className="neko-cz__header">
          <h2 id="neko-gifts-title">선물함 <span className="neko-gifts__count">{gifts.length}</span></h2>
          <button type="button" className="neko-cz__close" onClick={onClose} aria-label="닫기"><X size={14} /></button>
        </header>
        <div className="neko-cz__body">
          <p className="settings-section__desc">칸을 네코 자리로 끌어다 놓아. 높이 두면 벽에 걸리고, 놓인 걸 우클릭하면 치울 수 있어.</p>
          <ul className="neko-gifts__grid">
            {[...gifts].reverse().map((g) => (
              <li
                key={g.id}
                className={`neko-gifts__item${g.placed ? " neko-gifts__item--placed" : ""}`}
                title={`${g.body || g.title}\n${DAY.format(new Date(g.at))}에 받음${g.placed ? " · 무대에 놓여 있어" : ""}`}
                onPointerDown={(e) => dragGift(e, g.id)}
              >
                <GiftThumb shape={g.shape} size={64} />
                <span className="neko-gifts__title">{g.title}</span>
                <button type="button" className="settings-btn neko-gifts__btn" onClick={() => place(g.id, g.placed ? null : "auto")}>
                  {g.placed ? "치우기" : "바닥에 놓기"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>,
    document.body,
  );
}

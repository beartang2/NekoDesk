import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertDialog } from "radix-ui";
import { Trash2 } from "lucide-react";
import { drawShape, shapeBounds, type GiftShape } from "./engine/gift-shape";
import { PLACE_NAME, fits, smallestPlace, useNekoGifts, type NekoGift } from "./gifts";
import { useNekoStore, type NekoPlacement } from "./nekoStore";
import { GiftLab } from "./GiftLab";
import { josa } from "../lib/hangul";
import "./NekoCustomizeModal.css";
import "../components/Update.css"; // 확인 창은 새 버전 창과 같은 모양
import "./NekoGiftBox.css";

/** 선물 그림. 무대와 같은 그리기 함수(drawShape)라 그림체가 같다. */
export function GiftThumb({ shape, size = 56 }: { shape: GiftShape; size?: number }) {
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

const DAY = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" });

/** 지금 장소에 놓을 수 있는 크기 안내 */
const RULE: Record<NekoPlacement, string> = {
  sidebar: "방엔 작은 것만 들어가.",
  dock: "거실엔 작은 것과 중간 것까지 들어가.",
  screen: "마당엔 뭐든 놓을 수 있어.",
};

/** 칸 버튼: 여기 놓였으면 치우기, 다른 장소에 놓였으면 여기로(안 맞으면 치우기), 안 놓였으면 놓기(안 맞으면 어디부터인지) */
function action(g: NekoGift, here: NekoPlacement): { label: string; run: (() => void) | null } {
  const { place } = useNekoGifts.getState();
  const ok = fits(g.size, here);
  if (g.placed?.at === here || (g.placed && !ok)) return { label: "치우기", run: () => place(g.id, null) };
  if (g.placed) return { label: "여기로", run: () => place(g.id, "auto", here) };
  if (ok) return { label: g.frame ? "걸기" : "놓기", run: () => place(g.id, "auto", here) };
  const min = smallestPlace(g.size);
  return { label: `${PLACE_NAME[min]}${min === "screen" ? "에만" : "부터"}`, run: null };
}

/**
 * 선물함(설정 › 고양이). 설정엔 개수와 '열기'만 두고, 목록은 따로 뜨는 창(NekoGiftPanel)에 — 선물은 100개까지 쌓여
 * 설정 화면을 밀어낸다. 설계: docs/neko-gifts.md §3. 놓은 자리는 무대 폭 비율이라 사이드바·아래 띠 어디서나 같은 자리에 보인다.
 */
export function NekoGiftBox() {
  const count = useNekoGifts((s) => s.gifts.length);
  useEffect(() => { void useNekoGifts.getState().load(); }, []);
  const open = () => void invoke("panel_open", { kind: "neko-gifts" }).catch(() => {});

  return (
    <div className="neko-gifts">
      <div className="neko-gifts__head">
        <span>선물함</span>
        <span className="neko-gifts__count">{count}</span>
        {(count > 0 || import.meta.env.DEV) && <button type="button" className="settings-btn neko-gifts__open" onClick={open}>열기</button>}
      </div>
      {count === 0 && <p className="settings-section__desc">아직 받은 선물이 없어. 네코가 산책에서 주워 오면 여기 쌓여.</p>}
    </div>
  );
}

/**
 * 선물함 창(panel_open "neko-gifts")을 채운다. 제목은 창 틀에. 메인 창과 선물은 windowSync 로 맞춘다 —
 * 다른 창이라 네코 자리로 끌어다 놓을 수는 없고, 칸 버튼으로 지금 장소에 놓거나 옮기거나 치운다.
 */
export function NekoGiftPanel() {
  const gifts = useNekoGifts((s) => s.gifts);
  const here = useNekoStore((s) => s.stage.placement);
  /** 버릴지 묻는 중인 선물 */
  const [drop, setDrop] = useState<NekoGift | null>(null);
  useEffect(() => { void useNekoGifts.getState().load(); }, []);

  return (
    <div className="neko-cz neko-cz--window">
      <div className="neko-cz__body">
        {import.meta.env.DEV && <GiftLab />}
        <p className="settings-section__desc">
          선물 {gifts.length}개. 지금 네코는 {PLACE_NAME[here]}에 있어. {RULE[here]} 놓기를 누르면 {PLACE_NAME[here]} 바닥에 놓여.
          {here !== "screen" && " 무대에선 끌어 옮기고(높이 두면 벽에 걸려), 우클릭하면 치울 수 있어."}
        </p>
        <ul className="neko-gifts__grid">
          {[...gifts].reverse().map((g) => {
            const ok = fits(g.size, here), act = action(g, here);
            return (
              <li
                key={g.id}
                className={`neko-gifts__item${g.placed ? " neko-gifts__item--placed" : ""}${ok ? "" : " neko-gifts__item--off"}`}
                title={`${g.body || g.title}\n${DAY.format(new Date(g.at))}에 받음${g.placed ? ` · ${PLACE_NAME[g.placed.at]}에 놓여 있어` : ""}`}
              >
                <button type="button" className="neko-gifts__drop" aria-label={`${g.title} 버리기`} title="버리기" onClick={() => setDrop(g)}>
                  <Trash2 size={12} />
                </button>
                <GiftThumb shape={g.shape} size={64} />
                <span className="neko-gifts__title">{g.title}</span>
                <button type="button" className="settings-btn neko-gifts__btn" disabled={!act.run} onClick={act.run ?? undefined}>
                  {act.label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {/* 버리기 확인. 처음 포커스는 취소, Esc 도 취소(Radix 가 Esc 를 먹어 창은 안 닫힌다). 버리면 windowSync 로 방·거실·마당에서도 빠진다 */}
      <AlertDialog.Root open={!!drop} onOpenChange={(open) => { if (!open) setDrop(null); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="update-overlay">
            <AlertDialog.Content className="update-dialog">
              <AlertDialog.Title className="update-dialog__title">
                {drop && `'${drop.title}'${josa(drop.title, "을/를").slice(drop.title.length)} 버릴까?`}
              </AlertDialog.Title>
              <AlertDialog.Description className="update-dialog__sub">되돌릴 수 없어.</AlertDialog.Description>
              <div className="update-dialog__actions">
                <AlertDialog.Cancel className="update-dialog__btn">취소</AlertDialog.Cancel>
                <AlertDialog.Action className="update-dialog__btn neko-gifts__drop-ok" onClick={() => drop && useNekoGifts.getState().remove(drop.id)}>
                  버리기
                </AlertDialog.Action>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Overlay>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { IS_PHONE } from "../lib/platform";
import { openNekoPanel } from "./panel";
import { invoke } from "@tauri-apps/api/core";
import { AlertDialog } from "radix-ui";
import { Trash2 } from "lucide-react";
import { drawShape, onShapeImage, shapeBounds, type GiftShape } from "./engine/gift-shape";
import { SCALE_MAX, SCALE_MIN } from "./engine/decor-draw";
import { PLACE_NAME, scaleCapped, useNekoGifts, type NekoGift } from "./gifts";
import { useNekoStore, type NekoPlacement } from "./nekoStore";
import { GiftLab } from "./GiftLab";
import { josa } from "../lib/hangul";
import { Segmented } from "../components/ui";
import { FurnitureTab, dropFurniture } from "./FurnitureTab";
import "./NekoCustomizeModal.css";
import "../components/Update.css"; // 확인 창은 새 버전 창과 같은 모양
import "./NekoGiftBox.css";

/** 선물 그림. 무대와 같은 그리기 함수(drawShape)라 그림체가 같다. */
export function GiftThumb({ shape, size = 56 }: { shape: GiftShape; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // 낙서 그림(shape.img)은 처음 그릴 땐 아직 못 읽어 매트만 보인다 — 다 읽으면 다시 그린다
  const [loaded, setLoaded] = useState(0);
  useEffect(() => (shape.img ? onShapeImage(() => setLoaded((n) => n + 1)) : undefined), [shape.img]);
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);
    const b = shapeBounds(shape), u = (size * 0.78) / Math.max(b.w, b.h);
    drawShape(ctx, shape, size / 2 - ((b.x0 + b.x1) / 2) * u, size / 2 + (b.h * u) / 2, u, 3 * dpr);
  }, [shape, size, dpr, loaded]);
  return <canvas ref={ref} width={size * dpr} height={size * dpr} style={{ width: size, height: size }} aria-hidden />;
}

const DAY = new Intl.DateTimeFormat("ko-KR", { year: "numeric", month: "long", day: "numeric" });

/** 칸 버튼: 여기 놓였으면 치우기, 다른 장소에 놓였으면 여기로, 안 놓였으면 놓기(액자는 걸기). 크기로 자리를 막지 않는다 */
function action(g: NekoGift, here: NekoPlacement): { label: string; run: () => void } {
  const { place } = useNekoGifts.getState();
  if (g.placed?.at === here) return { label: "치우기", run: () => place(g.id, null) };
  return { label: g.placed ? "여기로" : g.frame ? "걸기" : "놓기", run: () => place(g.id, "auto", here) };
}

/**
 * 배율 슬라이더: 0.5 ~ 3배(기본 크기를 2배로 키운 뒤의 범위 — 0.5배가 예전 기본). 가운데가 1배이고 양쪽이 저마다 로그 눈금이다:
 * 슬라이더 값 t ∈ [-1, 1] 에서 왼쪽은 0.5^-t, 오른쪽은 3^t. 끝이 비대칭이어도 1배가 가운데에 오고 작은 쪽·큰 쪽이 다 세밀하다
 */
const toScale = (t: number) => (t < 0 ? SCALE_MIN ** -t : SCALE_MAX ** t);
const toT = (s: number) => Math.max(-1, Math.min(1, s < 1 ? -Math.log(s) / Math.log(SCALE_MIN) : Math.log(s) / Math.log(SCALE_MAX)));
const fmtScale = (s: number) => `×${+s.toFixed(s >= 1 ? 1 : 2)}`;

/**
 * 놓인 선물 크기(gifts resize). 끄는 동안엔 프레임마다 한 번만 메모리만 바꿔 무대가 바로 따라오고(windowSync),
 * 놓을 때 한 번 저장한다 — 동기화 기록이 쏟아지지 않게. 그 자리 상한에 걸리면 위에 작게 알린다(어림이라 몇 % 다를 수 있다)
 */
function GiftScale({ g, at }: { g: NekoGift; at: NekoPlacement }) {
  const [drag, setDrag] = useState<number | null>(null);
  const last = useRef(1), raf = useRef(0), dirty = useRef(false);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);
  const s = drag ?? g.scale ?? 1, t = toT(s);
  const resize = (v: number, save: boolean) => useNekoGifts.getState().resize(g.id, v, save);
  const live = (v: number) => {
    last.current = v; dirty.current = true; setDrag(v);
    if (!raf.current) raf.current = requestAnimationFrame(() => { raf.current = 0; resize(last.current, false); });
  };
  const commit = (v = last.current) => {
    cancelAnimationFrame(raf.current); raf.current = 0;
    dirty.current = false; setDrag(null);
    resize(v, true);
  };
  return (
    <div className="neko-gifts__scale">
      {scaleCapped({ ...g, scale: s }, at) && <span className="neko-gifts__cap">{PLACE_NAME[at]}에서는 이보다 크게 보이지 않습니다.</span>}
      <div className="neko-gifts__scale-row">
        <span>{fmtScale(s)}</span>
        {s !== 1 && <button type="button" className="neko-gifts__reset" onClick={() => commit(1)}>원래 크기</button>}
      </div>
      <input
        type="range"
        min={-1}
        max={1}
        step={0.025}
        value={t}
        onPointerDown={() => window.addEventListener("pointerup", () => { if (dirty.current) commit(); }, { once: true })}
        onKeyUp={() => { if (dirty.current) commit(); }}
        onChange={(e) => live(Math.round(toScale(Number(e.target.value)) * 100) / 100)}
        style={{ "--fill": `${((t + 1) / 2) * 100}%` } as CSSProperties}
        aria-label={`${g.title} 크기`}
      />
    </div>
  );
}

/**
 * 선물함(설정 › 고양이). 설정엔 개수와 '열기'만 두고, 목록은 따로 뜨는 창(NekoGiftPanel)에 — 선물은 100개까지 쌓여
 * 설정 화면을 밀어낸다. 설계: docs/neko-gifts.md §3. 놓은 자리는 무대 폭 비율이라 사이드바·아래 띠 어디서나 같은 자리에 보인다.
 */
export function NekoGiftBox() {
  const count = useNekoGifts((s) => s.gifts.length);
  useEffect(() => { void useNekoGifts.getState().load(); }, []);
  const open = () => openNekoPanel("neko-gifts");

  return (
    <div className="neko-gifts">
      <div className="neko-gifts__head">
        <span>선물함</span>
        <span className="neko-gifts__count">{count}</span>
        {(count > 0 || import.meta.env.DEV) && <button type="button" className="settings-btn neko-gifts__open" onClick={open}>열기</button>}
      </div>
      {count === 0 && <p className="settings-section__desc">받은 선물이 없습니다. 네코가 산책에서 주워 오면 여기에 모입니다.</p>}
    </div>
  );
}

/**
 * 선물함 창(panel_open "neko-gifts")을 채운다. 제목은 창 틀에. 메인 창과 선물은 windowSync 로 맞춘다 —
 * 다른 창이라 네코 자리로 끌어다 놓을 수는 없고, 칸 버튼으로 지금 장소에 놓거나 옮기거나 치운다.
 */
/** 선물함 탭(선물·가구). 마지막으로 본 탭은 이 기기에만 */
type GiftTab = "gifts" | "furniture";
const TAB_KEY = "nekodesk_giftbox_tab";
const loadTab = (): GiftTab => { try { return localStorage.getItem(TAB_KEY) === "furniture" ? "furniture" : "gifts"; } catch { return "gifts"; } };

export function NekoGiftPanel() {
  const gifts = useNekoGifts((s) => s.gifts);
  const here = useNekoStore((s) => s.stage.placement);
  const [tab, setTabState] = useState<GiftTab>(loadTab);
  const setTab = (t: GiftTab) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* 저장 못 해도 지금은 바뀐다 */ } };
  /** 버릴지 묻는 중인 것(선물 또는 물어온 가구): 제목과 버리기 */
  const [drop, setDrop] = useState<{ title: string; run: () => void } | null>(null);
  const askDrop = (g: NekoGift) => setDrop({ title: g.title, run: () => useNekoGifts.getState().remove(g.id) });
  /** 폰: 설명을 펼친 선물. 맥은 칸에 올려 두면 툴팁으로 보지만 폰엔 '올려 둠'이 없다 */
  const [info, setInfo] = useState<NekoGift | null>(null);
  useEffect(() => { void useNekoGifts.getState().load(); }, []);

  return (
    <div className="neko-cz neko-cz--window">
      <div className="neko-cz__body">
        <div className="neko-gifts__tabs">
          <Segmented<GiftTab> value={tab} onChange={setTab} options={[{ value: "gifts", label: "선물" }, { value: "furniture", label: "가구" }]} />
        </div>
        {tab === "furniture" ? (
          <FurnitureTab onDrop={(f) => setDrop({ title: f.title || "가구", run: () => void dropFurniture(f) })} />
        ) : (<>
        {import.meta.env.DEV && <GiftLab />}
        <p className="settings-section__desc">
          선물 {gifts.length}개. 지금 네코는 {PLACE_NAME[here]}에 있습니다. 놓기를 누르면 {PLACE_NAME[here]} 바닥에 놓이고, 놓인 선물은 칸에서 크기를 바꿀 수 있습니다.
          {here !== "screen" && ` ${PLACE_NAME[here]}에서 끌어 옮길 수 있고, 높이 두면 벽에 걸립니다. 우클릭하면 치울 수 있습니다.`}
        </p>
        <ul className="neko-gifts__grid">
          {[...gifts].reverse().map((g) => {
            const act = action(g, here);
            return (
              <li
                key={g.id}
                className={`neko-gifts__item${g.placed ? " neko-gifts__item--placed" : ""}`}
                title={`${g.body || g.title}\n${DAY.format(new Date(g.at))}에 받음${g.placed ? ` · ${PLACE_NAME[g.placed.at]}에 놓여 있음` : ""}`}
              >
                <button type="button" className="neko-gifts__drop" aria-label={`${g.title} 버리기`} title="버리기" onClick={() => askDrop(g)}>
                  <Trash2 size={12} />
                </button>
                {IS_PHONE ? (
                  <button type="button" className="neko-gifts__peek" onClick={() => setInfo(g)} aria-label={`${g.title} 설명 보기`}>
                    <GiftThumb shape={g.shape} size={64} />
                    <span className="neko-gifts__title">{g.title}</span>
                  </button>
                ) : (
                  <>
                    <GiftThumb shape={g.shape} size={64} />
                    <span className="neko-gifts__title">{g.title}</span>
                  </>
                )}
                {g.placed && <GiftScale g={g} at={g.placed.at} />}
                <button type="button" className="settings-btn neko-gifts__btn" onClick={act.run}>
                  {act.label}
                </button>
              </li>
            );
          })}
        </ul>
        </>)}
      </div>
      {/* 폰: 선물 설명 카드. 선물함 장 안에 그려 왼쪽 끝 손짓으로 장을 닫을 때 같이 움직인다 */}
      {info && (
        <div className="gift-info" onClick={(e) => { if (e.target === e.currentTarget) setInfo(null); }}>
          <div className="gift-info__card" role="dialog" aria-label={info.title}>
            <GiftThumb shape={info.shape} size={96} />
            <h3 className="gift-info__title">{info.title}</h3>
            {info.body && <p className="gift-info__body">{info.body}</p>}
            <p className="gift-info__meta">
              {DAY.format(new Date(info.at))}에 받음{info.placed ? ` · ${PLACE_NAME[info.placed.at]}에 놓여 있음` : ""}
            </p>
            <div className="gift-info__actions">
              <button type="button" className="update-dialog__btn update-dialog__btn--danger" onClick={() => { askDrop(info); setInfo(null); }}>버리기</button>
              <button type="button" className="update-dialog__btn" onClick={() => setInfo(null)}>닫기</button>
            </div>
          </div>
        </div>
      )}
      {/* 버리기 확인. 처음 포커스는 취소, Esc 도 취소(Radix 가 Esc 를 먹어 창은 안 닫힌다). 버리면 windowSync 로 방·거실·마당에서도 빠진다 */}
      <AlertDialog.Root open={!!drop} onOpenChange={(open) => { if (!open) setDrop(null); }}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="update-overlay">
            <AlertDialog.Content className="update-dialog">
              <AlertDialog.Title className="update-dialog__title">
                {drop && `'${drop.title}'${josa(drop.title, "을/를").slice(drop.title.length)} 버리시겠습니까?`}
              </AlertDialog.Title>
              <AlertDialog.Description className="update-dialog__sub">되돌릴 수 없습니다.</AlertDialog.Description>
              <div className="update-dialog__actions">
                <AlertDialog.Cancel className="update-dialog__btn">취소</AlertDialog.Cancel>
                <AlertDialog.Action className="update-dialog__btn update-dialog__btn--danger" onClick={() => drop?.run()}>
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

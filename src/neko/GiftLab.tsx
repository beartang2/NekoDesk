import { useState } from "react";
import { drawGift, type DrawnGift } from "../agent/gift-draw";
import { GiftThumb } from "./NekoGiftBox";
import { useNekoGifts } from "./gifts";

/** 무대에서 크기별 배율(엔진 decorDims 와 같은 값) */
const SCALE = { small: 0.6, medium: 1, large: 1.45 } as const;

/**
 * 선물 그림 시험(개발 빌드의 선물함 창). 물건 이름을 적으면 산책과 같은 길(gift-draw.ts)로 그려 보여 준다 —
 * 처음 그림과 보고 고친 그림, 밝은·어두운 바탕, 무대에 놓였을 때 크기. 모델을 두 번 부른다.
 */
export function GiftLab() {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ title: string; d: DrawnGift | null; sec: number } | null>(null);

  const run = async () => {
    const title = name.trim();
    if (!title || busy) return;
    setBusy(true);
    const t0 = performance.now();
    const d = await drawGift(title).catch(() => null);
    setOut({ title, d, sec: (performance.now() - t0) / 1000 });
    setBusy(false);
  };
  const d = out?.d;
  const size = (d?.size && d.size in SCALE ? d.size : "medium") as keyof typeof SCALE;

  return (
    <section className="gift-lab">
      <form className="gift-lab__form" onSubmit={(e) => { e.preventDefault(); void run(); }}>
        <input
          className="settings-input" value={name} onChange={(e) => setName(e.target.value)}
          placeholder="그려 볼 물건 (예: 솔방울, 깃털, 유리구슬)" aria-label="그려 볼 물건"
        />
        <button type="submit" className="settings-btn" disabled={busy || !name.trim()}>{busy ? "그리는 중" : "그려 보기"}</button>
      </form>
      {out && !d && <p className="settings-section__desc">'{out.title}'을(를) 못 그렸어. 모델이 도형을 내지 않았어(프로필·예산을 확인해 줘).</p>}
      {out && d && (
        <>
          <div className="gift-lab__row">
            {([["처음 그림", d.first], ["고친 그림", d.shape]] as const).map(([label, shape]) => (
              <figure key={label} className="gift-lab__fig">
                <div className="gift-lab__tiles">
                  <span className="gift-lab__tile gift-lab__tile--light"><GiftThumb shape={shape} size={112} /></span>
                  <span className="gift-lab__tile gift-lab__tile--dark"><GiftThumb shape={shape} size={112} /></span>
                </div>
                <figcaption>{label}{label === "고친 그림" && d.first === d.shape ? " (그대로)" : ""} · 도형 {shape.parts.length}개</figcaption>
              </figure>
            ))}
            <figure className="gift-lab__fig">
              <div className="gift-lab__tiles gift-lab__tiles--real">
                {(Object.keys(SCALE) as (keyof typeof SCALE)[]).map((k) => (
                  <span key={k} className={`gift-lab__real${k === size ? " is-picked" : ""}`}>
                    <GiftThumb shape={d.shape} size={Math.round(44 * SCALE[k])} />
                    <small>{k}</small>
                  </span>
                ))}
              </div>
              <figcaption>무대 크기 · 모델이 고른 건 {size}{d.play ? ` · 놀이 ${d.play}` : ""}</figcaption>
            </figure>
          </div>
          <div className="gift-lab__foot">
            <span className="settings-section__desc">{out.title} · {out.sec.toFixed(1)}초</span>
            <button type="button" className="settings-btn" onClick={() => void run()} disabled={busy}>다시 그리기</button>
            <button
              type="button" className="settings-btn"
              onClick={() => useNekoGifts.getState().add({ title: out.title, body: "시험으로 그린 선물", shape: d.shape, play: d.play, size: d.size })}
            >선물함에 넣기</button>
          </div>
        </>
      )}
    </section>
  );
}

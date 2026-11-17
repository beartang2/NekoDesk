
import type { NekoAppearance, NekoPattern } from "./engine/neko-engine";
import { useNekoStore } from "./nekoStore";

/** 설정창 '고양이' 영역: 자리(채팅 바 아래로 내리기)와 외형. 바꾸면 바로 네코에 반영되고 저장된다. */

type Opt<K extends string> = { key: K; name: string; swatch?: string };

const COATS: Opt<NekoAppearance["coat"]>[] = [
  { key: "black", name: "까망", swatch: "#161418" },
  { key: "cheese", name: "치즈", swatch: "#e2984a" },
  { key: "gray", name: "회색", swatch: "#8f8b98" },
  { key: "cream", name: "크림", swatch: "#ead2ac" },
  { key: "white", name: "하양", swatch: "#f2efe9" },
];
const PATTERNS: Opt<NekoPattern>[] = [
  { key: "white", name: "흰 반점" },
  { key: "calico", name: "삼색" },
  { key: "tabby", name: "줄무늬" },
  { key: "point", name: "포인트" },
];
const EYES: Opt<NekoAppearance["eye"]>[] = [
  { key: "yellow", name: "노랑", swatch: "#f2cd3a" },
  { key: "white", name: "하양", swatch: "#f4f0e8" },
  { key: "green", name: "연두", swatch: "#c1dc62" },
  { key: "blue", name: "파랑", swatch: "#8ec5ec" },
];
const FURS: Opt<NekoAppearance["fur"]>[] = [{ key: "short", name: "단모" }, { key: "medium", name: "중모" }, { key: "long", name: "장모" }];
const EARS: Opt<NekoAppearance["ear"]>[] = [{ key: "pointy", name: "뾰족" }, { key: "round", name: "동글" }, { key: "fold", name: "접힌 귀" }];
const TAILS: Opt<NekoAppearance["tail"]>[] = [{ key: "long", name: "길쭉" }, { key: "fluffy", name: "복슬" }, { key: "bob", name: "짧은 꼬리" }];
const BUILDS: Opt<NekoAppearance["build"]>[] = [{ key: "slim", name: "날씬" }, { key: "normal", name: "보통" }, { key: "chubby", name: "통통" }];
const LEGS: Opt<NekoAppearance["legs"]>[] = [{ key: "short", name: "짧게" }, { key: "normal", name: "보통" }, { key: "long", name: "길게" }];

function Choice<K extends string>({ label, opts, value, onPick }: { label: string; opts: Opt<K>[]; value: K; onPick: (k: K) => void }) {
  return (
    <div className="neko-settings__row">
      <span className="neko-settings__label">{label}</span>
      <div className="cat-variant-grid" role="radiogroup" aria-label={label}>
        {opts.map((o) => (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={o.key === value}
            className={`cat-skin-option ${o.key === value ? "cat-skin-option--active" : ""}`}
            onClick={() => onPick(o.key)}
          >
            {o.swatch && <span className="cat-skin-swatch" style={{ background: o.swatch }} />}
            <span>{o.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function NekoSettingsSection() {
  const a = useNekoStore((s) => s.appearance);
  const placement = useNekoStore((s) => s.stage.placement);
  const setAppearance = useNekoStore((s) => s.setAppearance);
  const reroll = useNekoStore((s) => s.reroll);
  const setPlacement = useNekoStore((s) => s.setPlacement);
  const set = <K extends keyof NekoAppearance>(k: K) => (v: NekoAppearance[K]) => setAppearance({ [k]: v } as Partial<NekoAppearance>);
  const togglePattern = (p: NekoPattern) => {
    const cur = new Set(a.patterns);
    if (cur.has(p)) cur.delete(p); else cur.add(p);
    setAppearance({ patterns: [...cur] });
  };

  return (
    <section className="settings-section neko-settings">
      <h3 className="settings-section__title">고양이</h3>

      <div className="server-checkbox-row">
        <label className="server-checkbox-row__item">
          <input type="checkbox" checked={placement === "dock"} onChange={(e) => setPlacement(e.target.checked ? "dock" : "sidebar")} />
          <span>채팅 바 아래로 내리기</span>
        </label>
      </div>
      <p className="settings-section__desc">
        켜면 네코가 사이드바 패널에서 대화 입력창 아래 띠로 옮겨 가서 더 넓게 걸어 다녀. 어느 자리든 위쪽 가장자리를 끌어 높이를 바꿀 수 있어(고양이 크기가 높이를 따라가).
      </p>

      <Choice label="털 색" opts={COATS} value={a.coat} onPick={set("coat")} />
      <div className="neko-settings__row">
        <span className="neko-settings__label">무늬</span>
        <div className="cat-variant-grid" role="group" aria-label="무늬(겹쳐서 고를 수 있음)">
          {PATTERNS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={a.patterns.includes(p.key)}
              className={`cat-skin-option ${a.patterns.includes(p.key) ? "cat-skin-option--active" : ""}`}
              onClick={() => togglePattern(p.key)}
            >
              {p.name}
            </button>
          ))}
          <button type="button" className="settings-btn settings-btn--ghost" onClick={reroll}>무늬 다시 뽑기</button>
        </div>
      </div>
      <Choice label="눈 색" opts={EYES} value={a.eye} onPick={set("eye")} />
      <Choice label="털 길이" opts={FURS} value={a.fur} onPick={set("fur")} />
      <Choice label="귀" opts={EARS} value={a.ear} onPick={set("ear")} />
      <Choice label="꼬리" opts={TAILS} value={a.tail} onPick={set("tail")} />
      <Choice label="체형" opts={BUILDS} value={a.build} onPick={set("build")} />
      <Choice label="다리 길이" opts={LEGS} value={a.legs} onPick={set("legs")} />
      <div className="neko-settings__row">
        <label className="neko-settings__label" htmlFor="neko-soft">말랑함</label>
        <input
          id="neko-soft"
          type="range"
          min={0}
          max={100}
          value={Math.round(a.soft * 100)}
          onChange={(e) => setAppearance({ soft: Number(e.target.value) / 100 })}
        />
      </div>
    </section>
  );
}



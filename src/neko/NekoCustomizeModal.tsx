import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, Eye, Feather, Palette, Sparkles, Waves, X, type LucideIcon } from "lucide-react";
import { createNeko, type NekoAppearance, type NekoController, type NekoPattern, type NekoPose } from "./engine/neko-engine";
import { useNekoStore } from "./nekoStore";
import { CatGlyph, EyeGlyph, PatternGlyph, PoseGlyph } from "./NekoGlyph";
import { coatSwatch, summarizeAppearance } from "./summarize";
import "./NekoCustomizeModal.css";

/**
 * 네코 꾸미기 창. 시안 페이지처럼 위엔 미리보기 무대(따로 돌리는 엔진 하나), 아래엔 고르기 칩.
 * 고르면 바로 미리보기와 앱의 네코에 함께 반영되고 저장된다. '처음대로'는 창을 열 때의 모습으로 되돌린다.
 */

type Opt<K extends string> = { key: K; name: string; swatch?: string };

const COATS: Opt<Exclude<NekoAppearance["coat"], "custom">>[] = [
  { key: "black", name: "까망", swatch: "#161418" },
  { key: "cheese", name: "치즈", swatch: "#e2984a" },
  { key: "gray", name: "회색", swatch: "#8f8b98" },
  { key: "cream", name: "크림", swatch: "#ead2ac" },
  { key: "white", name: "하양", swatch: "#f2efe9" },
];
const EYES: Opt<NekoAppearance["eye"]>[] = [
  { key: "yellow", name: "노랑", swatch: "#f2cd3a" },
  { key: "white", name: "하양", swatch: "#f4f0e8" },
  { key: "green", name: "연두", swatch: "#c1dc62" },
  { key: "blue", name: "파랑", swatch: "#8ec5ec" },
];
const PATTERNS: Opt<NekoPattern>[] = [
  { key: "white", name: "흰 반점" }, { key: "calico", name: "삼색" }, { key: "tabby", name: "줄무늬" }, { key: "point", name: "포인트" },
];
const BUILDS: Opt<NekoAppearance["build"]>[] = [{ key: "slim", name: "날씬" }, { key: "normal", name: "보통" }, { key: "chubby", name: "통통" }];
const LEGS: Opt<NekoAppearance["legs"]>[] = [{ key: "short", name: "짧게" }, { key: "normal", name: "보통" }, { key: "long", name: "길게" }];
const FURS: Opt<NekoAppearance["fur"]>[] = [{ key: "short", name: "단모" }, { key: "medium", name: "중모" }, { key: "long", name: "장모" }];
const EARS: Opt<NekoAppearance["ear"]>[] = [{ key: "pointy", name: "뾰족" }, { key: "round", name: "동글" }, { key: "fold", name: "접힌 귀" }];
const TAILS: Opt<NekoAppearance["tail"]>[] = [{ key: "long", name: "길쭉" }, { key: "fluffy", name: "복슬" }, { key: "bob", name: "짧은 꼬리" }];
const POSES: Opt<NekoPose>[] = [{ key: "stand", name: "서기" }, { key: "sit", name: "앉기" }, { key: "loaf", name: "식빵" }, { key: "lie", name: "누워 자기" }];

const isDarkNow = () => !document.documentElement.classList.contains("light");

/** 한 번에 다 고르지 않고 단계별로: 색 → 무늬 → 눈 → 몸 → 털·귀·꼬리 → 말랑함·확인 */
const STEPS = [
  { key: "coat", icon: Palette, title: "털 색", desc: "기본 색을 고르거나 '직접 고르기'로 RGB 색을 골라요. 줄무늬·포인트 색은 고른 색에서 알아서 만들어요." },
  { key: "pattern", icon: Waves, title: "무늬", desc: "겹쳐서 골라도 돼요(줄무늬 + 흰 반점 = 고등어 턱시도). 모양이 마음에 들 때까지 다시 뽑아요." },
  { key: "eye", icon: Eye, title: "눈 색", desc: "눈 색을 골라요." },
  { key: "body", icon: null, title: "체형·다리", desc: "몸통 크기와 다리 길이를 골라요. 미리보기 자세를 바꿔 앉은 모습도 봐요." },
  { key: "fur", icon: Feather, title: "털·귀·꼬리", desc: "털 길이, 귀 모양, 꼬리를 골라요." },
  { key: "finish", icon: Sparkles, title: "말랑함·확인", desc: "말랑할수록 몸이 크게·오래 출렁이고 배가 살짝 처져요. 값을 바꾸거나 '콕 눌러 보기'를 누르면 미리보기가 눌렸다 출렁여요." },
] as const satisfies readonly { key: string; icon: LucideIcon | null; title: string; desc: string }[];

function Chips<K extends string>({ name, opts, value, onPick, glyph, tile }: {
  name: string; opts: Opt<K>[]; value: K | null; onPick: (k: K) => void;
  /** 고르면 어떻게 보이는지 그린 작은 그림 */
  glyph?: (k: K) => ReactNode;
  /** 그림을 위, 이름을 아래에 놓는 카드 모양 */
  tile?: boolean;
}) {
  return (
    <div className="neko-cz__chips" role="radiogroup" aria-label={name}>
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          className={`neko-cz__chip${o.swatch && !glyph ? " neko-cz__chip--swatch" : ""}${glyph && !tile ? " neko-cz__chip--glyph" : ""}${tile ? " neko-cz__chip--tile" : ""}`}
          onClick={() => onPick(o.key)}
        >
          {glyph ? glyph(o.key) : o.swatch && <i className="neko-cz__swatch" style={{ background: o.swatch }} />}
          <span>{o.name}</span>
        </button>
      ))}
    </div>
  );
}

function Field({ legend, hint, children }: { legend: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="neko-cz__field">
      <legend>{legend}{hint && <span className="neko-cz__hint-inline">{hint}</span>}</legend>
      {children}
    </fieldset>
  );
}

export function NekoCustomizeModal({ onClose }: { onClose: () => void }) {
  const a = useNekoStore((s) => s.appearance);
  const setAppearance = useNekoStore((s) => s.setAppearance);
  const reroll = useNekoStore((s) => s.reroll);
  const initial = useRef(a);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [preview, setPreview] = useState<NekoController | null>(null);
  const [pose, setPose] = useState<NekoPose>("stand");
  const [hex, setHex] = useState(a.color);
  const [step, setStep] = useState(0);
  const last = step === STEPS.length - 1;

  // 미리보기 엔진: 시안처럼 무대 배경을 그리고, 창을 닫으면 없앤다
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const c = createNeko(cv, { transparent: false, scaleMode: "height", dark: isDarkNow(), appearance: useNekoStore.getState().appearance });
    setPreview(c);
    if (import.meta.env.DEV) (window as unknown as { __nekoPreview?: NekoController }).__nekoPreview = c; // 브라우저 점검용
    const unsub = useNekoStore.subscribe((s, p) => { if (s.appearance !== p.appearance) c.setAppearance(s.appearance); });
    return () => { unsub(); c.destroy(); };
  }, []);
  useEffect(() => { preview?.setPose(pose); }, [preview, pose]);
  useEffect(() => { setHex(a.color); }, [a.color]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const cat = (patch: Partial<NekoAppearance>) => <CatGlyph className="neko-cz__glyph" shape={{ ...a, ...patch }} />;
  const set = <K extends keyof NekoAppearance>(k: K) => (v: NekoAppearance[K]) => setAppearance({ [k]: v } as Partial<NekoAppearance>);
  const togglePattern = (p: NekoPattern) => {
    const cur = new Set(a.patterns);
    if (cur.has(p)) cur.delete(p); else cur.add(p);
    setAppearance({ patterns: [...cur] });
  };
  const applyHex = (v: string) => {
    const t = v.trim().startsWith("#") ? v.trim() : `#${v.trim()}`;
    if (/^#[0-9a-f]{6}$/i.test(t)) setAppearance({ coat: "custom", color: t.toLowerCase() });
    else setHex(a.color);
  };

  return createPortal(
    <div className="neko-cz__backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="neko-cz" role="dialog" aria-modal="true" aria-labelledby="neko-cz-title">
        <header className="neko-cz__header">
          <h2 id="neko-cz-title">네코 꾸미기</h2>
          <button type="button" className="neko-cz__close" onClick={onClose} aria-label="닫기"><X size={14} /></button>
        </header>

        <div className="neko-cz__body">
          <section className="neko-cz__stage-card" aria-label="미리보기">
            <canvas
              ref={canvasRef}
              className="neko-cz__stage"
              tabIndex={0}
              role="img"
              aria-label="미리보기 고양이. 누르면 쓰다듬고, 빠르게 두 번 누르면 뛰어오르고, 누른 채로 끌면 목덜미를 잡아요."
            />
            <div className="neko-cz__stage-bar">
              <Chips name="미리보기 자세" opts={POSES} value={pose} onPick={setPose} glyph={(k) => <PoseGlyph className="neko-cz__glyph neko-cz__glyph--sm" pose={k} ear={a.ear} />} />
              <button type="button" className="neko-cz__btn" onClick={() => preview?.jump()}>점프</button>
            </div>
            <p className="neko-cz__stage-hint">
              <span><b>누르기</b> 쓰다듬기</span><span><b>두 번 누르기</b> 점프</span><span><b>누른 채로 끌기</b> 목덜미 잡기</span>
              <span>자세는 미리보기에만 써요</span>
            </p>
          </section>

          <section className="neko-cz__controls">
            {/* 단계 표시: 눌러서 오갈 수 있다 */}
            <ol className="neko-cz__steps" aria-label="꾸미기 단계">
              {STEPS.map((st, i) => (
                <li key={st.key}>
                  <button
                    type="button"
                    className={`neko-cz__step${i === step ? " is-current" : ""}${i < step ? " is-done" : ""}`}
                    aria-current={i === step ? "step" : undefined}
                    onClick={() => setStep(i)}
                  >
                    <span className="neko-cz__step-no" aria-hidden="true">
                      {i < step ? <Check size={12} strokeWidth={3} /> : st.icon ? <st.icon size={12} strokeWidth={2.2} /> : <CatGlyph className="neko-cz__step-cat" shape={a} />}
                    </span>
                    <span className="neko-cz__step-name">{st.title}</span>
                  </button>
                </li>
              ))}
            </ol>

            <div className="neko-cz__panel" key={STEPS[step].key}>
              <h3 className="neko-cz__panel-title">{STEPS[step].title}</h3>
              <p className="neko-cz__panel-desc">{STEPS[step].desc}</p>

              {STEPS[step].key === "coat" && (
                <>
                  <div className="neko-cz__chips" role="radiogroup" aria-label="털 색">
                    {COATS.map((o) => (
                      <button key={o.key} type="button" role="radio" aria-checked={a.coat === o.key}
                        className="neko-cz__chip neko-cz__chip--swatch" onClick={() => setAppearance({ coat: o.key })}>
                        <i className="neko-cz__swatch" style={{ background: o.swatch }} />{o.name}
                      </button>
                    ))}
                    {/* 직접 고르기: 시스템 색 고르기 창(RGB)을 연다 */}
                    <label className={`neko-cz__chip neko-cz__chip--swatch neko-cz__chip--picker${a.coat === "custom" ? " is-selected" : ""}`}>
                      <input
                        type="color"
                        value={a.color}
                        onChange={(e) => setAppearance({ coat: "custom", color: e.target.value })}
                        aria-label="털 색 직접 고르기(RGB)"
                      />
                      <i className="neko-cz__swatch neko-cz__swatch--rainbow" style={{ background: a.coat === "custom" ? a.color : undefined }} />
                      직접 고르기
                    </label>
                  </div>
                  {a.coat === "custom" && (
                    <div className="neko-cz__hexrow">
                      <span>RGB</span>
                      <input
                        className="neko-cz__hex"
                        value={hex}
                        onChange={(e) => setHex(e.target.value)}
                        onBlur={(e) => applyHex(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") applyHex((e.target as HTMLInputElement).value); }}
                        spellCheck={false}
                        aria-label="털 색 RGB 값(#rrggbb)"
                      />
                      <span className="neko-cz__rgb">{[1, 3, 5].map((i) => parseInt(a.color.slice(i, i + 2), 16)).join(" · ")}</span>
                    </div>
                  )}
                </>
              )}

              {STEPS[step].key === "pattern" && (
                <div className="neko-cz__chips" role="group" aria-label="무늬">
                  {PATTERNS.map((p) => (
                    <button key={p.key} type="button" aria-pressed={a.patterns.includes(p.key)} className="neko-cz__chip neko-cz__chip--swatch" onClick={() => togglePattern(p.key)}>
                      <PatternGlyph className="neko-cz__swatch-glyph" pattern={p.key} base={coatSwatch(a)} />
                      {p.name}
                    </button>
                  ))}
                  <button type="button" className="neko-cz__btn" onClick={reroll}>무늬 다시 뽑기</button>
                </div>
              )}

              {STEPS[step].key === "eye" && <Chips name="눈 색" opts={EYES} value={a.eye} onPick={set("eye")} glyph={(k) => <EyeGlyph className="neko-cz__glyph neko-cz__glyph--eye" color={EYES.find((e) => e.key === k)!.swatch!} />} />}

              {STEPS[step].key === "body" && (
                <div className="neko-cz__pickers">
                  <Field legend="체형"><Chips name="체형" opts={BUILDS} value={a.build} onPick={set("build")} tile glyph={(k) => cat({ build: k })} /></Field>
                  <Field legend="다리 길이"><Chips name="다리 길이" opts={LEGS} value={a.legs} onPick={set("legs")} tile glyph={(k) => cat({ legs: k })} /></Field>
                </div>
              )}

              {STEPS[step].key === "fur" && (
                <div className="neko-cz__pickers">
                  <Field legend="털 길이"><Chips name="털 길이" opts={FURS} value={a.fur} onPick={set("fur")} tile glyph={(k) => cat({ fur: k })} /></Field>
                  <Field legend="귀"><Chips name="귀" opts={EARS} value={a.ear} onPick={set("ear")} tile glyph={(k) => cat({ ear: k })} /></Field>
                  <Field legend="꼬리"><Chips name="꼬리" opts={TAILS} value={a.tail} onPick={set("tail")} tile glyph={(k) => cat({ tail: k })} /></Field>
                </div>
              )}

              {STEPS[step].key === "finish" && (
                <>
                  <div className="neko-cz__tune">
                    <label htmlFor="neko-cz-soft">말랑함</label>
                    <span className="neko-cz__range">
                      <span aria-hidden="true">단단</span>
                      {/* 손을 떼면 미리보기를 콕 눌러 지금 말랑함을 바로 보여 준다 */}
                      <input id="neko-cz-soft" type="range" min={0} max={100} value={Math.round(a.soft * 100)}
                        onChange={(e) => setAppearance({ soft: Number(e.target.value) / 100 })}
                        onPointerUp={() => preview?.boing(1)}
                        onKeyUp={(e) => { if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") preview?.boing(1); }} />
                      <span aria-hidden="true">말랑</span>
                    </span>
                    <output htmlFor="neko-cz-soft">{Math.round(a.soft * 100)}</output>
                    <button type="button" className="neko-cz__btn" onClick={() => preview?.boing(1)}>콕 눌러 보기</button>
                  </div>
                  <p className="neko-cz__summary">
                    <i className="neko-cz__swatch" style={{ background: coatSwatch(a) }} />
                    {summarizeAppearance(a)}
                  </p>
                </>
              )}
            </div>
          </section>
        </div>

        <footer className="neko-cz__footer">
          <button type="button" className="neko-cz__btn" onClick={() => setAppearance(initial.current)}>처음대로</button>
          <span className="neko-cz__footer-gap" />
          <span className="neko-cz__progress" aria-live="polite">{step + 1} / {STEPS.length}</span>
          <button type="button" className="neko-cz__btn" onClick={() => setStep((v) => Math.max(0, v - 1))} disabled={step === 0}>이전</button>
          {last
            ? <button type="button" className="neko-cz__btn neko-cz__btn--primary" onClick={onClose}>완료</button>
            : <button type="button" className="neko-cz__btn neko-cz__btn--primary" onClick={() => setStep((v) => v + 1)}>다음</button>}
        </footer>
      </div>
    </div>,
    document.body,
  );
}

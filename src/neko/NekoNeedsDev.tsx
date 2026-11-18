import { NEED_KEYS, soloOdds, type NeedKey } from "./director/needs";
import { useNekoNeeds } from "./director/needsStore";

/**
 * 개발 빌드에서만: 숨은 게이지 넷과 다음 혼자 놀기 확률 상위 5개(docs/neko-activity-mix.md §2.7).
 * 숫자를 보며 고치려고 둔다. window.__nekoNeeds 로도 읽고 쓴다.
 */
const NAME: Record<NeedKey, string> = { energy: "기운", curiosity: "호기심", clean: "청결", affection: "애정" };

export function NekoNeedsDev() {
  const needs = useNekoNeeds((s) => s.needs);
  const set = useNekoNeeds((s) => s.set);
  const top = soloOdds(needs, { last: null, hasGifts: false }).sort((a, b) => b.p - a.p).slice(0, 5);
  return (
    <div className="neko-needs-dev">
      <p className="settings-section__desc">숨은 게이지(개발 빌드에서만)</p>
      {NEED_KEYS.map((k) => (
        <div key={k} className="ui-switch-row">
          <span style={{ width: 48 }}>{NAME[k]}</span>
          <span style={{ flex: 1, height: 6, borderRadius: 3, background: "var(--border, #444)", overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: `${needs[k]}%`, background: "var(--accent, #8af)" }} />
          </span>
          <span style={{ width: 32, textAlign: "right" }}>{Math.round(needs[k])}</span>
          <button type="button" className="settings-btn" onClick={() => set({ [k]: needs[k] - 30 })}>−30</button>
          <button type="button" className="settings-btn" onClick={() => set({ [k]: needs[k] + 30 })}>+30</button>
        </div>
      ))}
      <p className="settings-section__desc">
        다음 혼자 놀기: {top.map((o) => `${o.key} ${Math.round(o.p * 100)}%`).join(" · ")}
      </p>
    </div>
  );
}

import { useEffect } from "react";
import { nextResetFor, useClaudeBudget } from "../stores/claudeBudget";
import "./ClaudeUsage.css";

/** 이번 주기 사용액 / 예산. 제목 표시줄 팝업과 설정에서 같이 쓴다. */
export function ClaudeUsageMeter({ compact = false }: { compact?: boolean }) {
  const settings = useClaudeBudget((s) => s.settings);
  const usage = useClaudeBudget((s) => s.usage);
  const refresh = useClaudeBudget((s) => s.refresh);
  // 앱을 며칠 켜둔 채 갱신일이 지났을 수 있다. 보일 때마다 주기를 맞춘다.
  useEffect(() => { refresh(); }, [refresh]);

  const limit = settings.budgetUsd > 0 ? settings.budgetUsd : null;
  const ratio = limit ? Math.min(1, usage.spentUsd / limit) : 0;
  const level = ratio >= 1 ? "over" : ratio >= 0.8 ? "warn" : "ok";

  return (
    <div className="claude-meter">
      <div className="claude-meter__row">
        <span className="claude-meter__label">이번 주기 Claude 사용</span>
        <span className="claude-meter__amount">
          ${usage.spentUsd.toFixed(2)}
          {limit !== null && <span className="claude-meter__limit"> / ${limit}</span>}
        </span>
      </div>
      {limit !== null && (
        <div className="claude-meter__bar" role="meter" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={usage.spentUsd}>
          <span className={`claude-meter__fill claude-meter__fill--${level}`} style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
      {!compact && (
        <div className="claude-meter__sub">
          요청 {usage.requests.toLocaleString()}회 · {nextResetFor(new Date(), settings.resetDay)} 에 0 으로
        </div>
      )}
    </div>
  );
}

/** 예산과 갱신일. 갱신일은 claude.ai 결제일과 맞춘다 — 크레딧이 그날 들어온다. */
export function ClaudeBudgetFields() {
  const settings = useClaudeBudget((s) => s.settings);
  const setSettings = useClaudeBudget((s) => s.setSettings);

  return (
    <div className="gen-params-grid">
      <label className="gen-param">
        <span className="gen-param__label">월 예산 (USD)</span>
        <input className="gen-param__input" type="number" step="5" min="0"
          title="네코가 이번 주기에 쓸 수 있는 금액. 넘으면 다음 갱신일까지 Claude 요청을 보내지 않는다. 0 이면 제한 없음."
          value={settings.budgetUsd}
          onChange={(e) => setSettings({ budgetUsd: Math.max(0, parseFloat(e.target.value) || 0) })} />
      </label>
      <label className="gen-param">
        <span className="gen-param__label">갱신일 (매달)</span>
        <input className="gen-param__input" type="number" step="1" min="1" max="28"
          title="claude.ai 설정 → 결제에 나오는 결제일. API 크레딧이 그날 새로 들어온다. 29~31일은 28일로 친다."
          value={settings.resetDay}
          onChange={(e) => setSettings({ resetDay: parseInt(e.target.value, 10) || 1 })} />
      </label>
    </div>
  );
}

import { useEffect, useState } from "react";
import { Popover } from "radix-ui";
import { ChevronDown, Loader2, SlidersHorizontal } from "lucide-react";
import { useSettingsStore } from "../stores/settingsStore";
import {
  activateProfile,
  isClaudeProfile,
  loadProfiles,
  modelLabel,
  probe,
  profileUrl,
  saveProfiles,
  type ModelProfile,
  type ProfileState,
} from "../stores/modelProfiles";
import { ClaudeUsageMeter } from "./ClaudeUsage";
import "./ModelSwitcher.css";

function kindLabel(p: ModelProfile): string {
  if (isClaudeProfile(p)) return "Claude";
  return p.config ? "로컬" : "외부";
}

/**
 * 제목 표시줄의 모델 고르기. 설정을 열지 않고 대화하던 자리에서 바로 바꾼다.
 *
 * 프로필 목록·연결 방법은 설정의 "모델 프로필" 과 똑같다(같은 저장소, 같은 activateProfile).
 * 여기선 고르기만 하고, 만들기·고치기는 "모델 관리" 로 설정에 넘긴다.
 */
export function ModelSwitcher({ onManage }: { onManage: () => void }) {
  const llmUrl = useSettingsStore((s) => s.llmUrl);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ProfileState>(loadProfiles);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 설정에서 프로필을 바꾸거나 고쳤을 수 있다. 열 때와 주소가 바뀔 때 다시 읽는다.
  useEffect(() => { setState(loadProfiles()); }, [open, llmUrl]);

  const active = state.profiles.find((p) => p.id === state.activeId) ?? null;

  async function pick(p: ModelProfile) {
    if (p.id === state.activeId && !error) {
      setOpen(false);
      return;
    }
    setBusyId(p.id);
    setError(null);
    const prev = active;
    const next = { ...state, activeId: p.id };
    setState(next);
    saveProfiles(next);
    try {
      await activateProfile(p, prev);
      // Claude 는 띄울 서버가 없어 연결이 늘 성공한다. 키가 없으면 첫 질문에서야 알게 되니 여기서 알린다.
      if (isClaudeProfile(p) && (await probe(profileUrl(p), 1500)) === null) {
        setError("Claude API 키가 없어. 모델 관리에서 넣어줘.");
        return;
      }
      setOpen(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={(o) => { setOpen(o); if (!o) setError(null); }}>
      <Popover.Trigger className="model-chip" title="모델 바꾸기">
        {busyId ? <Loader2 size={11} className="ui-spin" /> : <span className="model-chip__dot" />}
        <span className="model-chip__name">{active?.name ?? "모델 없음"}</span>
        <ChevronDown size={11} className="model-chip__caret" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="model-pop" side="bottom" align="end" sideOffset={6} collisionPadding={12}>
          <div className="model-pop__title">모델</div>
          <div className="model-pop__list" role="listbox" aria-label="모델 프로필">
            {state.profiles.map((p) => {
              const isActive = p.id === state.activeId;
              return (
                <button key={p.id} role="option" aria-selected={isActive}
                  className={`model-pop__item ${isActive ? "model-pop__item--active" : ""}`}
                  disabled={busyId !== null}
                  onClick={() => pick(p)}>
                  <span className="model-pop__text">
                    <span className="model-pop__name">{p.name}</span>
                    <span className="model-pop__sub">{modelLabel(p)}</span>
                  </span>
                  {busyId === p.id
                    ? <Loader2 size={11} className="ui-spin" />
                    : <span className="model-pop__tag">{kindLabel(p)}</span>}
                </button>
              );
            })}
          </div>

          {error && <div className="model-pop__error">{error}</div>}

          {active && isClaudeProfile(active) && (
            <div className="model-pop__meter"><ClaudeUsageMeter compact /></div>
          )}

          <button className="model-pop__manage" onClick={() => { setOpen(false); onManage(); }}>
            <SlidersHorizontal size={12} />
            모델 관리
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

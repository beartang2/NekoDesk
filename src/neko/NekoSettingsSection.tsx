import { useState } from "react";
import { SwitchRow } from "../components/ui";
import { NekoCustomizeModal } from "./NekoCustomizeModal";
import { useNekoStore } from "./nekoStore";
import { coatSwatch, summarizeAppearance } from "./summarize";

/**
 * 설정창 '고양이' 영역: 자리 토글(채팅 바 아래로 내리기)과 지금 모습 요약,
 * '네코 꾸미기' 버튼(미리보기가 있는 꾸미기 창을 연다).
 */

export function NekoSettingsSection() {
  const a = useNekoStore((s) => s.appearance);
  const placement = useNekoStore((s) => s.stage.placement);
  const setPlacement = useNekoStore((s) => s.setPlacement);
  const [open, setOpen] = useState(false);

  return (
    <section className="settings-section neko-settings">
      <h3 className="settings-section__title">고양이</h3>

      <div className="neko-settings__summary">
        <i className="cat-skin-swatch" style={{ background: coatSwatch(a) }} />
        <span className="neko-settings__summary-text">{summarizeAppearance(a)}</span>
        <button type="button" className="settings-btn" onClick={() => setOpen(true)}>네코 꾸미기</button>
      </div>

      <SwitchRow label="채팅 바 아래로 내리기" checked={placement === "dock"} onChange={(on) => setPlacement(on ? "dock" : "sidebar")} />
      <p className="settings-section__desc">
        켜면 네코가 사이드바 패널에서 대화 입력창 아래 띠로 옮겨 가서 더 넓게 걸어 다녀. 어느 자리든 위쪽 가장자리를 끌어 높이를 바꿀 수 있어(고양이 크기가 높이를 따라가).
      </p>

      {open && <NekoCustomizeModal onClose={() => setOpen(false)} />}
    </section>
  );
}

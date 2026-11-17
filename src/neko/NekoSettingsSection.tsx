import { useState } from "react";
import { Segmented, SwitchRow, type Option } from "../components/ui";
import { NekoCustomizeModal } from "./NekoCustomizeModal";
import { NekoGiftBox } from "./NekoGiftBox";
import { SCREEN_SCALE, useNekoStore, type NekoPlacement } from "./nekoStore";
import { coatSwatch, summarizeAppearance } from "./summarize";

/**
 * 설정창 '고양이' 영역: 자리 고르기(패널·채팅 바 아래·모니터 화면)와 지금 모습 요약,
 * '네코 꾸미기' 버튼(미리보기가 있는 꾸미기 창을 연다).
 */

// 모니터 화면 자리는 macOS 의 투명·클릭 통과 창으로 만든다(neko_screen.rs)
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
const PLACES: Option<NekoPlacement>[] = [
  { value: "sidebar", label: "패널" },
  { value: "dock", label: "채팅 바 아래" },
  ...(IS_MAC ? [{ value: "screen" as const, label: "모니터 화면" }] : []),
];
const PLACE_DESC: Record<NekoPlacement, string> = {
  sidebar: "사이드바 패널에서 지내. 위쪽 가장자리를 끌어 높이를 바꾸면 고양이 크기가 따라가.",
  dock: "대화 입력창 아래 띠로 내려가서 더 넓게 걸어 다녀. 위쪽 가장자리를 끌어 높이를 바꿀 수 있어.",
  screen: "앱 밖으로 나가 맥 화면 맨 아래(Dock 위)를 걸어 다녀. 고양이 위에서만 클릭을 받고 나머지는 뒤로 지나가. ⌥ 를 누르고 있으면 고양이도 통과해.",
};

export function NekoSettingsSection() {
  const a = useNekoStore((s) => s.appearance);
  const placement = useNekoStore((s) => s.stage.placement);
  const setPlacement = useNekoStore((s) => s.setPlacement);
  const onTop = useNekoStore((s) => s.stage.screenOnTop);
  const scale = useNekoStore((s) => s.stage.screenScale);
  const setScreen = useNekoStore((s) => s.setScreen);
  const [open, setOpen] = useState(false);

  return (
    <section className="settings-section neko-settings">
      <h3 className="settings-section__title">고양이</h3>

      <div className="neko-settings__summary">
        <i className="cat-skin-swatch" style={{ background: coatSwatch(a) }} />
        <span className="neko-settings__summary-text">{summarizeAppearance(a)}</span>
        <button type="button" className="settings-btn" onClick={() => setOpen(true)}>네코 꾸미기</button>
      </div>

      <Segmented value={placement} onChange={setPlacement} options={PLACES} />
      <p className="settings-section__desc">{PLACE_DESC[placement]}</p>
      {placement === "screen" && (
        <>
          <SwitchRow label="항상 위에 두기" checked={onTop} onChange={(v) => setScreen({ screenOnTop: v })} />
          <p className="settings-section__desc">끄면 모든 창 아래로 내려가 바탕화면에서만 보여. 화면 공유나 녹화할 때 꺼 둬.</p>
          <label className="ui-switch-row">
            <span>크기</span>
            <input
              type="range"
              min={SCREEN_SCALE.min}
              max={SCREEN_SCALE.max}
              step={0.05}
              value={scale}
              onChange={(e) => setScreen({ screenScale: Number(e.target.value) })}
              aria-label="화면 고양이 크기"
            />
          </label>
        </>
      )}

      <NekoGiftBox />

      {open && <NekoCustomizeModal onClose={() => setOpen(false)} />}
    </section>
  );
}

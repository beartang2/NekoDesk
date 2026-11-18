import { invoke } from "@tauri-apps/api/core";
import { Segmented, SwitchRow, type Option } from "../components/ui";
import { NekoGiftBox } from "./NekoGiftBox";
import { NekoNeedsDev } from "./NekoNeedsDev";
import { SCREEN_SCALE, useNekoStore, type NekoPlacement } from "./nekoStore";
import { nekoNameOf, useSettingsStore } from "../stores/settingsStore";
import { josa } from "../lib/hangul";
import { coatSwatch, summarizeAppearance } from "./summarize";

/**
 * 설정창 '고양이' 영역: 자리 고르기(패널·채팅 바 아래·모니터 화면)와 지금 모습 요약,
 * '네코 꾸미기' 버튼(미리보기가 있는 꾸미기 창을 연다).
 */

// 모니터 화면 자리는 macOS 의 투명·클릭 통과 창으로 만든다(neko_screen.rs)
const IS_MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
const FPS_OPTIONS: Option<"30" | "60">[] = [{ value: "30", label: "30" }, { value: "60", label: "60" }];
const PLACES: Option<NekoPlacement>[] = [
  { value: "sidebar", label: "패널" },
  { value: "dock", label: "채팅 바 아래" },
  ...(IS_MAC ? [{ value: "screen" as const, label: "모니터 화면" }] : []),
];
/** 자리 설명. 문장 속 호칭은 지어 준 이름(조사는 받침에 맞춘다) */
const placeDesc = (place: NekoPlacement, name: string): string => ({
  sidebar: `${josa(name, "이/가")} 사이드바 패널에서 지내. 위쪽 가장자리를 끌어 높이를 바꾸면 고양이 크기가 따라가.`,
  dock: `${josa(name, "이/가")} 대화 입력창 아래 띠로 내려가서 더 넓게 걸어 다녀. 위쪽 가장자리를 끌어 높이를 바꿀 수 있어.`,
  screen: `${josa(name, "이/가")} 앱 밖으로 나가 맥 화면 맨 아래(Dock 위)를 걸어 다녀. ${name} 위에서만 클릭을 받고 나머지는 뒤로 지나가. ⌥ 를 누르고 있으면 ${name}도 통과해.`,
})[place];

export function NekoSettingsSection() {
  const a = useNekoStore((s) => s.appearance);
  const placement = useNekoStore((s) => s.stage.placement);
  const setPlacement = useNekoStore((s) => s.setPlacement);
  const onTop = useNekoStore((s) => s.stage.screenOnTop);
  const scale = useNekoStore((s) => s.stage.screenScale);
  const fps = useNekoStore((s) => s.stage.screenFps);
  const setScreen = useNekoStore((s) => s.setScreen);
  const name = useSettingsStore(nekoNameOf);
  const follow = useSettingsStore((s) => s.nekoFollowApps);
  const setFollow = useSettingsStore((s) => s.setNekoFollowApps);

  return (
    <section className="settings-section neko-settings">
      <h3 className="settings-section__title">고양이</h3>

      <div className="neko-settings__summary">
        <i className="cat-skin-swatch" style={{ background: coatSwatch(a) }} />
        <span className="neko-settings__summary-text">{summarizeAppearance(a)}</span>
        <button type="button" className="settings-btn" onClick={() => void invoke("panel_open", { kind: "neko-customize" }).catch(() => {})}>네코 꾸미기</button>
      </div>

      <Segmented value={placement} onChange={setPlacement} options={PLACES} />
      <p className="settings-section__desc">{placeDesc(placement, name)}</p>
      {placement === "screen" && (
        <>
          <SwitchRow label="항상 위에 두기" checked={onTop} onChange={(v) => setScreen({ screenOnTop: v })} />
          <p className="settings-section__desc">끄면 모든 창 아래로 내려가 바탕화면에서만 보여. 화면 공유나 녹화할 때 꺼 둬.</p>
          <div className="ui-switch-row">
            <span>크기</span>
            <input
              type="range"
              min={SCREEN_SCALE.min}
              max={SCREEN_SCALE.max}
              step={0.05}
              value={scale}
              onChange={(e) => setScreen({ screenScale: Number(e.target.value) })}
              style={{ "--fill": `${((scale - SCREEN_SCALE.min) / (SCREEN_SCALE.max - SCREEN_SCALE.min)) * 100}%` } as React.CSSProperties}
              aria-label={`화면 속 ${name} 크기`}
            />
          </div>
          <div className="ui-switch-row">
            <span>프레임</span>
            <Segmented value={fps === 30 ? "30" : "60"} onChange={(v) => setScreen({ screenFps: v === "30" ? 30 : 60 })} options={FPS_OPTIONS} />
          </div>
          <p className="settings-section__desc">60 은 앱 안처럼 부드럽고, 30 은 배터리를 아껴.</p>
        </>
      )}

      {IS_MAC && (
        <>
          <SwitchRow label="다른 앱 따라 하기" checked={follow} onChange={setFollow} />
          <p className="settings-section__desc">
            다른 앱에서 키를 치면 {name}도 같이 타이핑하고, 맨 앞 앱에 맞춰 그림을 그리거나 창밖을 보거나 책을 읽어.
            음악 앱이 재생 중이면 하던 걸 하면서 헤드폰을 써(처음 한 번 macOS 가 음악 앱 제어를 허락할지 물어). 무슨 키를 쳤는지는 안 봐.
          </p>
        </>
      )}

      <NekoGiftBox />

      {import.meta.env.DEV && <NekoNeedsDev />}

    </section>
  );
}

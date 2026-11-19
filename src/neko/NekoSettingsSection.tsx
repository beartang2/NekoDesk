import { invoke } from "@tauri-apps/api/core";
import { openNekoPanel } from "./panel";
import { PLACE_NAME } from "./gifts";
import { IS_PHONE } from "../lib/platform";
import { Segmented, SwitchRow, type Option } from "../components/ui";
import { NekoGiftBox } from "./NekoGiftBox";
import { SCREEN_SCALE, useNekoStore, type NekoPlacement } from "./nekoStore";
import { nekoNameOf, useSettingsStore } from "../stores/settingsStore";
import { josa } from "../lib/hangul";
import { coatSwatch, summarizeAppearance } from "./summarize";
import { WALLPAPERS } from "./Wallpaper";

/**
 * 설정창 '고양이' 영역: 자리 고르기(패널·채팅 바 아래·모니터 화면)와 지금 모습 요약,
 * '네코 꾸미기' 버튼(미리보기가 있는 꾸미기 창을 연다).
 */

// 모니터 화면 자리는 macOS 의 투명·클릭 통과 창으로 만든다(neko_screen.rs)
// 아이폰의 userAgent 에도 "like Mac OS X" 가 있어 폰은 따로 뺀다
const IS_MAC = !IS_PHONE && typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
const FPS_OPTIONS: Option<"30" | "60">[] = [{ value: "30", label: "30" }, { value: "60", label: "60" }];
// 자리 이름은 선물함과 같은 말을 쓴다(방·거실·마당, gifts.ts PLACE_NAME). 마당은 맥에만 있다
const PLACES: Option<NekoPlacement>[] = [
  { value: "sidebar", label: PLACE_NAME.sidebar },
  { value: "dock", label: PLACE_NAME.dock },
  ...(IS_MAC ? [{ value: "screen" as const, label: PLACE_NAME.screen }] : []),
];
/** 자리 설명. 문장 속 호칭은 지어 준 이름(조사는 받침에 맞춘다) */
const placeDesc = (place: NekoPlacement, name: string): string => IS_PHONE ? ({
  sidebar: `${josa(name, "이/가")} 방에서 지냅니다. 방은 대화 목록(화면 왼쪽 끝에서 오른쪽으로 밀기) 아래에 있습니다.`,
  dock: `${josa(name, "이/가")} 대화 창 위쪽 거실에서 걸어 다닙니다.`,
  screen: "",
})[place] : ({
  sidebar: `${josa(name, "이/가")} 방(사이드바)에서 지냅니다. 위쪽 가장자리를 끌면 방 높이와 고양이 크기가 바뀝니다.`,
  dock: `${josa(name, "이/가")} 거실(입력창 아래)에서 더 넓게 걸어 다닙니다. 위쪽 가장자리를 끌어 높이를 바꿀 수 있습니다.`,
  screen: `${josa(name, "이/가")} 앱 밖 마당(화면 맨 아래, Dock 위)을 걸어 다닙니다. ${name} 밖의 클릭은 뒤의 창으로 갑니다. ⌥ 를 누르고 있으면 ${name} 위의 클릭도 넘어갑니다.`,
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
  const wallpaper = useSettingsStore((s) => s.nekoWallpaper);
  const setWallpaper = useSettingsStore((s) => s.setNekoWallpaper);

  return (
    <section className="settings-section neko-settings">
      <h3 className="settings-section__title">고양이</h3>

      <div className="neko-settings__summary">
        <i className="cat-skin-swatch" style={{ background: coatSwatch(a) }} />
        <span className="neko-settings__summary-text">{summarizeAppearance(a)}</span>
        <button type="button" className="settings-btn" onClick={() => openNekoPanel("neko-customize")}>네코 꾸미기</button>
      </div>

      <Segmented value={placement} onChange={setPlacement} options={PLACES} />
      <p className="settings-section__desc">{placeDesc(placement, name)}</p>

      <div className="ui-switch-row">
        <span>벽지</span>
        <Segmented value={wallpaper} onChange={setWallpaper} options={WALLPAPERS} />
      </div>
      <p className="settings-section__desc">방과 거실의 벽지입니다. 벽색은 창밖 하늘을 따라 낮·노을·밤으로 바뀝니다.</p>
      {placement === "screen" && (
        <>
          <SwitchRow label="항상 위에 두기" checked={onTop} onChange={(v) => setScreen({ screenOnTop: v })} />
          <p className="settings-section__desc">끄면 바탕화면에서만 보입니다. 화면 공유나 녹화 중에는 꺼 두는 것을 권장합니다.</p>
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
          <p className="settings-section__desc">60 은 부드럽고, 30 은 배터리를 아낍니다.</p>
        </>
      )}

      <NekoGiftBox />

    </section>
  );
}

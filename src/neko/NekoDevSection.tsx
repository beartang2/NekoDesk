import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { SwitchRow } from "../components/ui";
import { NekoNeedsDev } from "./NekoNeedsDev";
import { useDevTools } from "./devTools";

/**
 * 설정 › 고양이 맨 아래 '개발자' 칸. 개발 빌드(import.meta.env.DEV)에서만 그린다 — 배포 빌드엔 칸 자체가 없다.
 * 콘솔로 다루던 개발용 훅을 여기 스위치·버튼으로 옮겼다. 표시는 모두 기본 꺼짐.
 */
export function NekoDevSection() {
  const perchDebug = useDevTools((s) => s.perchDebug);
  const walk = useDevTools((s) => s.walk);
  const director = useDevTools((s) => s.director);
  const [walkSays, setWalkSays] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);

  const setPerchDebug = (on: boolean) => {
    useDevTools.setState({ perchDebug: on });
    void invoke("neko_screen_perch_debug", { on }).catch(() => {});
  };
  const sendWalk = () => {
    if (!walk) return;
    setWalkSays("…");
    walk().then(setWalkSays, (e) => setWalkSays(`오류: ${String(e)}`));
  };
  const showLog = () => {
    if (!director) return;
    const t0 = performance.now();
    const lines = director.log().slice(-15).map((e) => `${((e.t - t0) / 1000).toFixed(1)}s ${e.what}`);
    setLog([`지금 층: ${director.layer() ?? "-"}`, ...lines].join("\n"));
  };

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">개발자</h3>
      <p className="settings-section__desc">개발 빌드에서만 보입니다.</p>

      <SwitchRow label="캣타워 표시" checked={perchDebug} onChange={setPerchDebug} />
      <p className="settings-section__desc">마당에서 창마다 발판(초록)·벽(파랑)과 빠진 이유를 화면에 표시합니다.</p>

      <div className="ui-switch-row">
        <span>산책</span>
        <button type="button" className="settings-btn" disabled={!walk} onClick={sendWalk}>바로 보내기</button>
      </div>
      {walkSays && <p className="settings-section__desc">{walkSays}</p>}

      <div className="ui-switch-row">
        <span>감독 기록</span>
        <button type="button" className="settings-btn" disabled={!director} onClick={showLog}>보기</button>
      </div>
      {log && <pre className="settings-section__desc" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{log}</pre>}

      <NekoNeedsDev />
    </section>
  );
}

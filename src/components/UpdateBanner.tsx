import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

/** 창을 닫아도 앱은 남아 있어서 켤 때 한 번만 보면 며칠씩 놓친다. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** offline = 확인 자체가 실패. failed = 받거나 설치하다 실패. */
type Phase = "checking" | "latest" | "available" | "installing" | "failed" | "offline";

/** 깃헙 Release 확인과 설치. 성공하면 앱이 다시 켜지므로 돌아오는 건 실패뿐이다. */
function useUpdate() {
  const [version, setVersion] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(() => {
    setPhase("checking");
    invoke<string | null>("update_check")
      .then((v) => {
        setVersion(v);
        setPhase(v ? "available" : "latest");
      })
      .catch(() => setPhase("offline"));
  }, []);

  const install = useCallback(() => {
    setPhase("installing");
    setError(null);
    invoke("update_install").catch((e) => {
      setError(String(e));
      setPhase("failed");
    });
  }, []);

  return { version, phase, error, check, install };
}

/**
 * 창 위 새 버전 안내. 켤 때와 6시간마다 확인한다.
 *
 * 확인 실패(오프라인 등)는 조용히 넘긴다 — 업데이트는 덤이고, 다음 확인이 있다.
 */
export function UpdateBanner() {
  const { version, phase, error, check, install } = useUpdate();
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    check();
    const id = window.setInterval(check, CHECK_EVERY_MS);
    return () => window.clearInterval(id);
  }, [check]);

  if (!version || version === dismissed) return null;
  if (phase !== "available" && phase !== "installing" && phase !== "failed") return null;

  return (
    <div className="error-banner update-banner">
      <span>
        {phase === "failed"
          ? `업데이트 실패: ${error}`
          : phase === "installing"
          ? "받는 중… 끝나면 다시 켜져"
          : `새 버전 v${version} 나왔어`}
      </span>
      {phase !== "installing" && (
        <span className="update-banner__actions">
          <button className="update-banner__btn" onClick={install}>
            {phase === "failed" ? "다시 시도" : "업데이트"}
          </button>
          <button className="error-banner__close" onClick={() => setDismissed(version)}>
            ✕
          </button>
        </span>
      )}
    </div>
  );
}

/** 설정 안의 업데이트 칸. 탭을 열 때마다 확인한다. */
export function UpdateSection() {
  const { version, phase, error, check, install } = useUpdate();
  const [current, setCurrent] = useState("");

  useEffect(() => {
    getVersion().then(setCurrent).catch(() => {});
    check();
  }, [check]);

  const status = import.meta.env.DEV
    ? "개발 실행에선 확인하지 않아."
    : {
        checking: "확인하는 중…",
        latest: "최신 버전이야.",
        available: `새 버전 v${version} 나왔어.`,
        installing: "받는 중… 끝나면 다시 켜져.",
        failed: `업데이트 실패: ${error}`,
        offline: "확인하지 못했어. 인터넷 연결을 봐줘.",
      }[phase];

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">업데이트</h3>
      <p className="settings-section__desc">
        {current && `지금 v${current}. `}
        {status}
      </p>
      {!import.meta.env.DEV && phase !== "checking" && phase !== "installing" && (
        <div className="settings-row settings-row--right">
          {phase === "available" || phase === "failed" ? (
            <button className="settings-btn" onClick={install}>
              {phase === "failed" ? "다시 시도" : "업데이트"}
            </button>
          ) : (
            <button className="settings-btn settings-btn--ghost" onClick={check}>
              다시 확인
            </button>
          )}
        </div>
      )}
    </section>
  );
}

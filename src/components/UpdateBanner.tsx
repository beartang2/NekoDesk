import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** 창을 닫아도 앱은 남아 있어서 켤 때 한 번만 보면 며칠씩 놓친다. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * 새 버전 안내. 깃헙 Release 를 주기적으로 확인하고, 누르면 받아서 다시 켠다.
 *
 * 확인 실패(오프라인 등)는 조용히 넘긴다 — 업데이트는 덤이고, 다음 확인이 있다.
 */
export function UpdateBanner() {
  const [version, setVersion] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const check = () => invoke<string | null>("update_check").then(setVersion).catch(() => {});
    check();
    const id = window.setInterval(check, CHECK_EVERY_MS);
    return () => window.clearInterval(id);
  }, []);

  if (!version || version === dismissed) return null;

  const install = () => {
    setInstalling(true);
    setError(null);
    // 성공하면 앱이 다시 켜지므로 돌아오는 건 실패뿐이다.
    invoke("update_install").catch((e) => {
      setInstalling(false);
      setError(String(e));
    });
  };

  return (
    <div className="error-banner update-banner">
      <span>
        {error
          ? `업데이트 실패: ${error}`
          : installing
          ? "받는 중… 끝나면 다시 켜져"
          : `새 버전 v${version} 나왔어`}
      </span>
      {!installing && (
        <span className="update-banner__actions">
          <button className="update-banner__btn" onClick={install}>
            {error ? "다시 시도" : "업데이트"}
          </button>
          <button className="error-banner__close" onClick={() => setDismissed(version)}>
            ✕
          </button>
        </span>
      )}
    </div>
  );
}

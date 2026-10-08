import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import "./Update.css";

/** 창을 닫아도 앱은 남아 있어서 켤 때 한 번만 보면 며칠씩 놓친다. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** offline = 확인 자체가 실패. failed = 받거나 설치하다 실패. */
type Phase = "checking" | "latest" | "available" | "installing" | "failed" | "offline";

/** 깃헙 Release 확인과 설치. 성공하면 앱이 다시 켜지므로 돌아오는 건 실패뿐이다. */
function useUpdate() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [current, setCurrent] = useState("");
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersion().then(setCurrent).catch(() => {});
  }, []);

  const check = useCallback(() => {
    setPhase("checking");
    invoke<UpdateInfo | null>("update_check")
      .then((u) => {
        setInfo(u);
        setPhase(u ? "available" : "latest");
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

  return { info, current, phase, error, check, install };
}

/**
 * Release 본문에서 변경 내역만. `---` 아래는 처음 설치하는 사람용 안내라
 * 이미 깔려 있는 앱에서 보여줄 이유가 없다.
 */
export function changelog(notes: string | null): string {
  return notes?.split(/(?:^|\n)-{3,}\s*\n/)[0].trim() || "자잘한 정리";
}

type Update = ReturnType<typeof useUpdate>;

/** 가운데 뜨는 새 버전 창. 받는 중에는 닫히지 않는다 — 곧 앱이 다시 켜진다. */
function UpdateDialog({ update, onClose }: { update: Update; onClose: () => void }) {
  const { info, current, phase, error, install } = update;
  const busy = phase === "installing";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  if (!info) return null;

  return createPortal(
    <div
      className="update-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="update-dialog" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <h2 id="update-title" className="update-dialog__title">새 버전 v{info.version}</h2>
        {current && <p className="update-dialog__sub">지금 쓰는 건 v{current}</p>}
        <div className="update-dialog__notes">
          <ReactMarkdown>{changelog(info.notes)}</ReactMarkdown>
        </div>
        {phase === "failed" && <p className="update-dialog__error">업데이트 실패: {error}</p>}
        <div className="update-dialog__actions">
          {busy ? (
            <span className="update-dialog__busy">받는 중… 끝나면 다시 켜져</span>
          ) : (
            <>
              <button className="update-dialog__btn" onClick={onClose}>나중에</button>
              <button className="update-dialog__btn update-dialog__btn--primary" onClick={install} autoFocus>
                {phase === "failed" ? "다시 시도" : "지금 업데이트"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * 켤 때와 6시간마다 확인해서, 새 버전이 있으면 창을 띄운다.
 *
 * 확인 실패(오프라인 등)는 조용히 넘긴다 — 업데이트는 덤이고, 다음 확인이 있다.
 * "나중에" 는 그 버전만 이번 실행 동안 접는다.
 */
export function UpdatePrompt() {
  const update = useUpdate();
  const { info, phase, check } = update;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const close = useCallback(() => setDismissed(info?.version ?? null), [info]);

  useEffect(() => {
    check();
    const id = window.setInterval(check, CHECK_EVERY_MS);
    return () => window.clearInterval(id);
  }, [check]);

  if (!info || info.version === dismissed) return null;
  if (phase !== "available" && phase !== "installing" && phase !== "failed") return null;
  return <UpdateDialog update={update} onClose={close} />;
}

/** 설정 안의 업데이트 칸. 탭을 열 때마다 확인하고, 새 버전이면 같은 창으로 변경 내역을 보여준다. */
export function UpdateSection() {
  const update = useUpdate();
  const { info, current, phase, check } = update;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    check();
  }, [check]);

  const status = import.meta.env.DEV
    ? "개발 실행에선 확인하지 않아."
    : {
        checking: "확인하는 중…",
        latest: "최신 버전이야.",
        available: `새 버전 v${info?.version} 나왔어.`,
        installing: "받는 중… 끝나면 다시 켜져.",
        failed: "업데이트하지 못했어.",
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
          {info && (phase === "available" || phase === "failed") ? (
            <button className="settings-btn" onClick={() => setOpen(true)}>
              변경 내역 보기
            </button>
          ) : (
            <button className="settings-btn settings-btn--ghost" onClick={check}>
              다시 확인
            </button>
          )}
        </div>
      )}
      {open && <UpdateDialog update={update} onClose={close} />}
    </section>
  );
}

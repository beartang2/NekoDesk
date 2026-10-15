import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import "./Update.css";

/** 창을 닫아도 앱은 남아 있어서 켤 때 한 번만 보면 며칠씩 놓친다. */
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** 변경 내역을 모아 올 곳. 업데이터 주소(tauri.conf.json)와 같은 레포다. */
const RELEASES_URL = "https://api.github.com/repos/beartang2/NekoDesk/releases?per_page=30";

interface UpdateInfo {
  version: string;
  /** 서버에선 Release 본문 그대로, collectNotes 를 거친 뒤엔 보여줄 변경 내역. */
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
      .then(async (u) => {
        if (u) u = { ...u, notes: await collectNotes(u) };
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
  return notes?.split(/(?:^|\n)-{3,}\s*\n/)[0].trim() || "작은 개선 사항이 포함되어 있습니다.";
}

export interface Release {
  tag_name: string;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
}

/** a 가 b 보다 새 버전인지. 글자로 비교하면 "0.1.10" 이 "0.1.9" 보다 낡게 나온다. */
function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/**
 * 지금 버전 다음부터 새 버전까지의 변경 내역을 새것부터 모은다. 여러 번 건너뛰어도
 * 그사이 고친 것이 다 보이게. 하나뿐이면 버전 제목 없이 그 내역만. 없으면 null.
 */
export function mergeChangelogs(releases: Release[], current: string, latest: string): string | null {
  const picked = releases
    .filter((r) => !r.draft && !r.prerelease)
    .map((r) => ({ version: r.tag_name.replace(/^v/, ""), body: r.body }))
    .filter(({ version }) => isNewer(version, current) && !isNewer(version, latest))
    .sort((a, b) => (isNewer(a.version, b.version) ? -1 : 1));
  if (picked.length === 0) return null;
  if (picked.length === 1) return changelog(picked[0].body);
  return picked.map(({ version, body }) => `## v${version}\n\n${changelog(body)}`).join("\n\n");
}

/** 못 가져오면(오프라인·요청 한도) 새 버전 것만 — 업데이트 안내를 막을 일은 아니다. */
async function collectNotes(u: UpdateInfo): Promise<string> {
  try {
    const [current, res] = await Promise.all([
      getVersion(),
      fetch(RELEASES_URL, { signal: AbortSignal.timeout(5000) }),
    ]);
    if (res.ok) {
      const merged = mergeChangelogs(await res.json(), current, u.version);
      if (merged) return merged;
    }
  } catch { /* 아래로 */ }
  return changelog(u.notes);
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
        {current && <p className="update-dialog__sub">현재 버전 v{current}</p>}
        <div className="update-dialog__notes">
          <ReactMarkdown>{info.notes ?? ""}</ReactMarkdown>
        </div>
        {phase === "failed" && <p className="update-dialog__error">업데이트하지 못했습니다: {error}</p>}
        <div className="update-dialog__actions">
          {busy ? (
            <span className="update-dialog__busy">다운로드 중… 완료되면 앱이 다시 시작됩니다.</span>
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

/** 상태마다 안내 문구와 색. 조사가 버전 숫자에 따라 바뀌지 않게 문장을 짠다. */
const SECTION_STATUS: Record<Phase, { tone: "muted" | "new" | "ok" | "error"; text: (v?: string) => string }> = {
  checking: { tone: "muted", text: () => "업데이트를 확인하는 중입니다…" },
  latest: { tone: "ok", text: () => "최신 버전을 사용하고 있습니다." },
  available: { tone: "new", text: (v) => `v${v} 업데이트가 있습니다.` },
  installing: { tone: "new", text: () => "업데이트를 설치하는 중입니다. 완료되면 앱이 다시 시작됩니다." },
  failed: { tone: "error", text: () => "업데이트를 설치하지 못했습니다." },
  offline: { tone: "error", text: () => "업데이트를 확인하지 못했습니다. 인터넷 연결을 확인해 주세요." },
};

/**
 * 설정 안의 업데이트 칸. 탭을 열 때마다 확인한다 — 켜 둔 채로도 새 버전을 알 수 있게.
 * "업데이트" 는 바로 설치하지 않고 같은 창으로 변경 내역부터 보여준다.
 */
export function UpdateSection() {
  const update = useUpdate();
  const { info, current, phase, check } = update;
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    check();
  }, [check]);

  const dev = import.meta.env.DEV;
  const { tone, text } = dev
    ? { tone: "muted" as const, text: () => "개발 실행에서는 업데이트를 확인하지 않습니다." }
    : SECTION_STATUS[phase];
  const hasUpdate = !!info && (phase === "available" || phase === "failed");

  return (
    <section className="settings-section">
      <h3 className="settings-section__title">업데이트</h3>
      <div className="update-status" data-tone={tone}>
        <div className="update-status__text">
          {current && (
            <span className="update-status__current">
              현재 버전 <strong>v{current}</strong>
            </span>
          )}
          <span className="update-status__msg">{text(info?.version)}</span>
        </div>
        {!dev && phase !== "checking" && phase !== "installing" && (
          hasUpdate ? (
            <button className="settings-btn update-status__btn" onClick={() => setOpen(true)}>
              업데이트
            </button>
          ) : (
            <button className="settings-btn settings-btn--ghost" onClick={check}>
              다시 확인
            </button>
          )
        )}
      </div>
      {open && <UpdateDialog update={update} onClose={close} />}
    </section>
  );
}

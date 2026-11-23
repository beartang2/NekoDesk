import remarkGfm from "remark-gfm";
import type { Options } from "react-markdown";

/**
 * 채팅 마크다운 플러그인 한 곳. GFM(표·링크 등)을 쓰되 물결 하나는 취소선으로 보지 않는다 — "1~16번 (id 33~1014)" 의 물결 사이가
 * 취소선이 됐다(사용자). 취소선은 ~~두 개~~ 만
 */
export const MD_PLUGINS: Options["remarkPlugins"] = [[remarkGfm, { singleTilde: false }]];

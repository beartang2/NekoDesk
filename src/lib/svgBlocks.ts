/**
 * 답에 글로 적힌 SVG 를 그림으로 보이게 나눈다. 폰에는 그림 도구(code.exec·image.*)가 없어, 그려 달라고 하면 모델이 SVG 코드를
 * 답에 그대로 쓴다 — 코드만 보였다(사용자). 다 닫힌(</svg>) 것만 그림으로 바꾸고, 쓰는 중이면 글 그대로 둔다.
 * 그림은 <img> 의 data 주소로 띄운다: 그 안에서는 스크립트가 돌지 않고 밖의 것을 불러오지도 않는다.
 */
export type Piece = { md: string } | { svg: string };

/** 이보다 긴 SVG 는 코드로 둔다(말풍선마다 다시 그리는 값) */
const SVG_MAX = 300_000;
const FENCE = /```[^\n`]*\n([\s\S]*?)```/g;
const BARE = /<svg[\s>][\s\S]*?<\/svg>/gi;
/** 코드 칸 안이 통째로 SVG 하나인가(앞의 <?xml …?>·<!DOCTYPE …> 은 있어도 된다) */
const whole = (code: string): string | null => {
  const m = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?(<svg[\s>][\s\S]*<\/svg>)\s*$/i.exec(code);
  return m && m[1].length <= SVG_MAX ? m[1] : null;
};

/** 코드 칸 밖에 그냥 적힌 <svg>…</svg> 를 나눈다 */
function bare(md: string, out: Piece[]): void {
  let from = 0;
  for (const m of md.matchAll(BARE)) {
    if (m[0].length > SVG_MAX) continue;
    if (m.index > from) out.push({ md: md.slice(from, m.index) });
    out.push({ svg: m[0] });
    from = m.index + m[0].length;
  }
  if (from < md.length) out.push({ md: md.slice(from) });
}

export function splitSvg(text: string): Piece[] {
  if (!/<\/svg>/i.test(text)) return [{ md: text }];
  const out: Piece[] = [];
  let from = 0;
  for (const m of text.matchAll(FENCE)) {
    bare(text.slice(from, m.index), out);
    const svg = whole(m[1]);
    out.push(svg ? { svg } : { md: m[0] });
    from = m.index + m[0].length;
  }
  // 남은 글에 아직 안 닫힌 코드 칸이 있으면(쓰는 중) 그 안은 건드리지 않는다
  const rest = text.slice(from), open = rest.indexOf("```");
  if (open < 0) bare(rest, out);
  else { bare(rest.slice(0, open), out); out.push({ md: rest.slice(open) }); }
  return out.filter((p) => "svg" in p || p.md.trim());
}

/** <img> 에 넣을 주소. 모델이 자주 빼먹는 xmlns 가 없으면 그림으로 안 읽혀서 넣는다 */
export function svgDataUrl(svg: string): string {
  const fixed = /^<svg[^>]*\sxmlns=/i.test(svg) ? svg : svg.replace(/^<svg/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  // base64 로(코드 실행이 만든 그림과 같은 꼴 — 맥 뷰어의 저장·복사가 이 꼴을 읽는다)
  const bytes = new TextEncoder().encode(fixed);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

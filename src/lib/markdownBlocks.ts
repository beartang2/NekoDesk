/**
 * 흘러나오는 답을 빈 줄에서 덩이로 나눈다. 끝난 덩이는 글이 그대로라 MdBlock 이 건너뛰고, 마지막 덩이만 다시
 * 해석한다 — 답이 길어져도 갱신마다 처음부터 다시 그리지 않는다(docs/neko-perf.md §3-3). 코드 울타리 안이거나
 * 다음 줄이 들여 쓴 줄(목록 이어 쓰기)이면 나누지 않는다. ponytail: 각주·참조 링크처럼 문서 전체를 봐야 하는
 * 문법은 흐르는 동안 덩이를 넘지 못한다 — 답이 끝나면 통째로 한 번 다시 그려 바로잡힌다.
 */
export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.split("\n"), out: string[] = [];
  let cur: string[] = [], fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const next = lines[i + 1];
    if (!fence && line.trim() === "" && cur.length && next !== undefined && next.trim() !== "" && !/^\s/.test(next)) {
      out.push(cur.join("\n"));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

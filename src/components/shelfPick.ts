/**
 * 보관함 고르기(Finder 와 같은 규칙): 그냥 누르면 그것 하나, ⌘ 누르고 누르면 하나씩 더하거나 빼고, ⇧ 누르고 누르면 마지막에
 * 고른 것(기준)부터 거기까지. 순수 함수라 테스트한다
 */
export function shelfPick(names: string[], sel: ReadonlySet<string>, anchor: string | null, name: string, mod: { meta: boolean; shift: boolean }) {
  if (mod.shift && anchor !== null && names.includes(anchor)) {
    const a = names.indexOf(anchor), b = names.indexOf(name);
    return { sel: new Set(names.slice(Math.min(a, b), Math.max(a, b) + 1)), anchor };
  }
  if (mod.meta) {
    const next = new Set(sel);
    if (!next.delete(name)) next.add(name);
    return { sel: next, anchor: name };
  }
  return { sel: new Set([name]), anchor: name };
}

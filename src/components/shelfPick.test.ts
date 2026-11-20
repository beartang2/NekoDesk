import { describe, it, expect } from "vitest";
import { shelfPick } from "./shelfPick";

const names = ["a", "b", "c", "d", "e"];
const none = { meta: false, shift: false };

describe("보관함 고르기(Finder 규칙)", () => {
  it("그냥 누르면 그것 하나, ⌘ 는 더하고 빼기, ⇧ 는 기준부터 거기까지", () => {
    let p = shelfPick(names, new Set(), null, "b", none);
    expect([...p.sel]).toEqual(["b"]);
    p = shelfPick(names, p.sel, p.anchor, "d", { meta: true, shift: false });
    expect([...p.sel].sort()).toEqual(["b", "d"]);
    p = shelfPick(names, p.sel, p.anchor, "b", { meta: true, shift: false });
    expect([...p.sel]).toEqual(["d"]);
    p = shelfPick(names, p.sel, "b", "e", { meta: false, shift: true });
    expect([...p.sel].sort()).toEqual(["b", "c", "d", "e"]);
    expect(p.anchor).toBe("b");
    p = shelfPick(names, p.sel, p.anchor, "a", { meta: false, shift: true }); // 기준 위쪽으로도
    expect([...p.sel].sort()).toEqual(["a", "b"]);
    expect([...shelfPick(names, p.sel, p.anchor, "c", none).sel]).toEqual(["c"]);
  });
  it("기준이 없거나 지워졌으면 ⇧ 도 그것 하나", () => {
    expect([...shelfPick(names, new Set(), null, "c", { meta: false, shift: true }).sel]).toEqual(["c"]);
    expect([...shelfPick(names, new Set(["z"]), "z", "c", { meta: false, shift: true }).sel]).toEqual(["c"]);
  });
});

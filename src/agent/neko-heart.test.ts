import { beforeEach, describe, expect, it, vi } from "vitest";

/** 네코의 성격(docs/neko-heart.md §2): 읽기·상한·재료 글·비밀 숨김·굳힌 노트 빼기 */
const h = vi.hoisted(() => ({ kv: new Map<string, string>() }));
vi.mock("../api/tauri", () => ({ settingsApi: { get: async (k: string) => h.kv.get(k) ?? null, set: async (k: string, v: string) => void h.kv.set(k, v) } }));

import { heartLines, loadHeart, markTold, parseHeart, removeTrait, SECRETS_MAX, TRAITS_MAX, unfolded, untoldSecrets, type Trait } from "./neko-heart";

const t = (id: string, kind: string, text: string, n = 1, extra: Partial<Trait> = {}) => ({ id, kind, text, since: "2026-11-20", at: "2026-11-22", n, ...extra });
beforeEach(() => h.kv.clear());

describe("성격 읽기", () => {
  it("모르는 종류·빈 글·겹친 번호·날짜 없는 줄은 버리고, 털어놓은 날은 비밀에만", () => {
    const got = parseHeart(JSON.stringify({ v: 1, traits: [
      t("a", "like", "햇볕"), t("a", "like", "겹친 번호"), t("b", "boss", "모르는 종류"), t("c", "habit", "  "),
      { id: "d", kind: "fear", text: "날짜 없음" }, t("e", "habit", "버릇", 2, { told: "2026-11-23" }), t("f", "secret", "비밀", 1, { told: "2026-11-23" }),
    ], folded: "2026-11-22T10:00:00Z", day: "2026-11-22" }));
    expect(got.traits.map((x) => x.id)).toEqual(["a", "e", "f"]);
    expect(got.traits.find((x) => x.id === "e")?.told).toBeUndefined();
    expect(got.traits.find((x) => x.id === "f")?.told).toBe("2026-11-23");
    expect(got).toMatchObject({ folded: "2026-11-22T10:00:00Z", day: "2026-11-22" });
    expect(parseHeart("엉망")).toEqual({ v: 1, traits: [] });
  });
  it("상한: 성격 40개(사건 수 적은 것부터 뺀다), 안 털어놓은 비밀 5개", () => {
    const many = Array.from({ length: 45 }, (_, i) => t(`x${i}`, "like", `좋아함 ${i}`, i + 1));
    expect(parseHeart(JSON.stringify({ traits: many })).traits).toHaveLength(TRAITS_MAX);
    expect(parseHeart(JSON.stringify({ traits: many })).traits.some((x) => x.id === "x0")).toBe(false);
    const secrets = Array.from({ length: 8 }, (_, i) => t(`s${i}`, "secret", `비밀 ${i}`));
    expect(untoldSecrets(parseHeart(JSON.stringify({ traits: secrets })))).toHaveLength(SECRETS_MAX);
  });
});

describe("재료 글", () => {
  const heart = parseHeart(JSON.stringify({ traits: [t("a", "like", "창가 햇볕", 3), t("s", "secret", "밤마다 몰래 하는 것"), t("k", "secret", "털어놓은 것", 1, { told: "2026-11-23" })] }));
  it("자기 마음(all)엔 안 털어놓은 비밀도 보이고, 사용자가 보는 글(told)엔 털어놓은 것까지만", () => {
    expect(heartLines(heart, { secrets: "all" })).toContain("밤마다 몰래 하는 것");
    const told = heartLines(heart, { secrets: "told" });
    expect(told).not.toContain("밤마다 몰래 하는 것");
    expect(told).toContain("털어놓은 것");
    expect(told.split("\n")[0]).toContain("창가 햇볕"); // 사건 수 많은 순
    expect(heartLines(heart, { secrets: "all", ids: true })).toContain("- a [좋아함]");
  });
  it("굳힌 노트(folded 앞)는 뺀다", () => {
    const notes = [{ at: "2026-11-21T00:00:00Z" }, { at: "2026-11-22T10:00:00Z" }, { at: "2026-11-23T00:00:00Z" }];
    expect(unfolded(notes, { v: 1, traits: [], folded: "2026-11-22T10:00:00Z" })).toEqual([{ at: "2026-11-23T00:00:00Z" }]);
    expect(unfolded(notes, { v: 1, traits: [] })).toHaveLength(3);
  });
});

describe("바꾸기", () => {
  it("털어놓으면 그 비밀에만 날이 붙고, 지우면 빠진다(저장된 값 위에)", async () => {
    h.kv.set("neko_heart", JSON.stringify({ traits: [t("s", "secret", "비밀"), t("a", "like", "햇볕")] }));
    await markTold("s", "2026-11-23");
    await markTold("a", "2026-11-23");
    let got = await loadHeart();
    expect(got.traits.map((x) => x.told)).toEqual(["2026-11-23", undefined]);
    got = await removeTrait("a");
    expect(got.traits.map((x) => x.id)).toEqual(["s"]);
    expect(JSON.parse(h.kv.get("neko_heart")!).traits).toHaveLength(1);
  });
});

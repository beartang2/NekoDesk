import { describe, it, expect } from "vitest";
import { changelog, mergeChangelogs, type Release } from "./Update";

describe("changelog", () => {
  it("Release 본문에서 --- 위 변경 내역만 남긴다", () => {
    expect(changelog("### 새로 생긴 것\n- 설정에서 확인\n\n---\n\n**처음 설치할 때**")).toBe(
      "### 새로 생긴 것\n- 설정에서 확인",
    );
  });

  it("변경 내역이 없으면 대신 쓸 말을 준다", () => {
    expect(changelog("\n\n---\n\n**처음 설치할 때**")).toBe("작은 개선 사항이 포함되어 있습니다.");
    expect(changelog("---\n\n**처음 설치할 때**")).toBe("작은 개선 사항이 포함되어 있습니다.");
    expect(changelog(null)).toBe("작은 개선 사항이 포함되어 있습니다.");
  });
});

describe("mergeChangelogs", () => {
  const rel = (v: string, notes: string, extra: Partial<Release> = {}): Release => ({
    tag_name: `v${v}`,
    body: `${notes}\n\n---\n\n**처음 설치할 때**`,
    draft: false,
    prerelease: false,
    ...extra,
  });
  const releases = [
    rel("0.1.10", "- 열"),
    rel("0.1.9", "- 아홉"),
    rel("0.1.8", "- 여덟", { draft: true }),
    rel("0.1.3", "- 셋"),
    rel("0.1.2", "- 둘"),
  ];

  it("지금 다음부터 새 버전까지 새것부터 모으고, 초안은 뺀다", () => {
    expect(mergeChangelogs(releases, "0.1.2", "0.1.10")).toBe(
      "## v0.1.10\n\n- 열\n\n## v0.1.9\n\n- 아홉\n\n## v0.1.3\n\n- 셋",
    );
  });

  it("하나뿐이면 버전 제목 없이 그 내역만", () => {
    expect(mergeChangelogs(releases, "0.1.9", "0.1.10")).toBe("- 열");
  });

  it("새 버전이 목록에 아직 없으면 null", () => {
    expect(mergeChangelogs(releases, "0.1.10", "0.1.11")).toBeNull();
  });
});

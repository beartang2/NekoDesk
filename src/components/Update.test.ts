import { describe, it, expect } from "vitest";
import { changelog } from "./Update";

describe("changelog", () => {
  it("Release 본문에서 --- 위 변경 내역만 남긴다", () => {
    expect(changelog("### 새로 생긴 것\n- 설정에서 확인\n\n---\n\n**처음 설치할 때**")).toBe(
      "### 새로 생긴 것\n- 설정에서 확인",
    );
  });

  it("변경 내역이 없으면 대신 쓸 말을 준다", () => {
    expect(changelog("\n\n---\n\n**처음 설치할 때**")).toBe("자잘한 정리");
    expect(changelog("---\n\n**처음 설치할 때**")).toBe("자잘한 정리");
    expect(changelog(null)).toBe("자잘한 정리");
  });
});

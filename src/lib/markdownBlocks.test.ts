import { describe, it, expect } from "vitest";
import { splitMarkdownBlocks } from "./markdownBlocks";

describe("splitMarkdownBlocks", () => {
  it("빈 줄에서 나누고, 코드 울타리 안·들여 쓴 이어 쓰기는 나누지 않는다", () => {
    const md = "첫 문단\n둘째 줄\n\n## 제목\n\n```js\na\n\nb\n```\n\n1. 하나\n\n   이어 씀\n2. 둘\n\n끝";
    expect(splitMarkdownBlocks(md)).toEqual([
      "첫 문단\n둘째 줄",
      "## 제목",
      "```js\na\n\nb\n```",
      "1. 하나\n\n   이어 씀\n2. 둘",
      "끝",
    ]);
  });
  it("흐르는 중 끝의 빈 줄은 마지막 덩이에 남긴다(다음 글이 오기 전엔 안 나눈다)", () => {
    expect(splitMarkdownBlocks("가\n\n나\n\n")).toEqual(["가", "나\n\n"]);
  });
});

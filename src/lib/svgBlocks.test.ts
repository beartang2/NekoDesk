import { describe, expect, it } from "vitest";
import { splitSvg, svgDataUrl } from "./svgBlocks";

const SVG = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';

describe("답에 적힌 SVG 를 그림으로", () => {
  it("코드 칸(```svg·```xml·말 없는 칸)과 그냥 적힌 <svg> 를 그림 조각으로 나눈다", () => {
    expect(splitSvg(`고양이야\n\n\`\`\`svg\n${SVG}\n\`\`\`\n\n어때?`)).toEqual([{ md: "고양이야\n\n" }, { svg: SVG }, { md: "\n\n어때?" }]);
    expect(splitSvg(`\`\`\`xml\n<?xml version="1.0"?>\n${SVG}\n\`\`\``)).toEqual([{ svg: SVG }]);
    expect(splitSvg(`여기 ${SVG} 끝`)).toEqual([{ md: "여기 " }, { svg: SVG }, { md: " 끝" }]);
  });
  it("쓰는 중(안 닫힘)·다른 코드·SVG 를 설명하는 코드 조각은 글 그대로", () => {
    expect(splitSvg("```svg\n<svg viewBox=\"0 0 10 10\"><circle")).toEqual([{ md: "```svg\n<svg viewBox=\"0 0 10 10\"><circle" }]);
    const js = "```js\nconst s = '<svg></svg>';\n```";
    expect(splitSvg(js)).toEqual([{ md: js }]);
    expect(splitSvg("그냥 글")).toEqual([{ md: "그냥 글" }]);
    // 닫힌 그림 뒤에 아직 쓰는 중인 코드 칸
    expect(splitSvg(`${SVG}\n\`\`\`svg\n<svg><rect`)).toEqual([{ svg: SVG }, { md: "```svg\n<svg><rect" }]);
  });
  it("xmlns 가 없으면 넣는다(없으면 <img> 가 못 그린다)", () => {
    const text = (url: string) => new TextDecoder().decode(Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0)));
    expect(text(svgDataUrl(SVG))).toContain('<svg xmlns="http://www.w3.org/2000/svg" viewBox');
    const has = '<svg xmlns="http://www.w3.org/2000/svg"><text>고양이</text></svg>';
    expect(text(svgDataUrl(has))).toBe(has); // 한글도 그대로, xmlns 는 한 번만
    expect(svgDataUrl(SVG).startsWith("data:image/svg+xml;base64,")).toBe(true);
  });
});

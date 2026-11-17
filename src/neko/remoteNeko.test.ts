// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { useNekoApp } from "./director/stores";
import { createRemoteNeko, dispatchEvt, type NekoCmd } from "./remoteNeko";

describe("remoteNeko(대리 컨트롤러)", () => {
  it("부른 것을 그대로 화면 창에 넘기고, 값이 필요한 것만 여기서 답한다", () => {
    const sent: NekoCmd[] = [];
    const neko = createRemoteNeko((c) => sent.push(c));
    neko.setMood("sleepy");
    neko.tail("up", 2);
    expect(sent).toEqual([{ m: "setMood", args: ["sleepy"] }, { m: "tail", args: ["up", 2] }]);
    // 스케줄러는 act() 직후 activity 를 동기로 읽는다
    neko.act("typing");
    expect(neko.activity).toBe("typing");
    expect(neko.react("pet")).toBe(true);
    expect(neko.drop()).toEqual([]);
    expect(neko.hit(1, 2)).toBe(false);
    // await 해도 thenable 로 오인되지 않는다
    expect((neko as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it("화면 창 이벤트를 구독자에게 넘기고, 만지면 '앱을 쓰는 중'으로 친다", () => {
    const neko = createRemoteNeko(() => {});
    const got: unknown[] = [];
    const off = neko.on("activity", (a) => got.push(a));
    useNekoApp.setState({ lastActiveAt: 0 });
    dispatchEvt({ ev: "activity", payload: "box" });
    expect(got).toEqual(["box"]);
    expect(useNekoApp.getState().lastActiveAt).toBe(0); // 활동 바뀜은 만진 게 아니다
    dispatchEvt({ ev: "pet" });
    expect(useNekoApp.getState().lastActiveAt).toBeGreaterThan(0);
    off();
    dispatchEvt({ ev: "activity", payload: null });
    expect(got).toEqual(["box"]);
  });
});

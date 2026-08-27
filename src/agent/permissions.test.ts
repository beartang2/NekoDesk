import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/tauri", () => ({
  settingsApi: { get: vi.fn(async () => null), set: vi.fn(async () => {}) },
}));

import {
  execRuleKey,
  parentDir,
  writeRuleKey,
  isAllowed,
  remember,
  clearSessionRules,
  listAlwaysRules,
  forgetAlwaysRule,
} from "./permissions";

beforeEach(() => clearSessionRules());

describe("execRuleKey", () => {
  it("셸은 도구+서브명령까지 묶는다 — status 승인이 push 를 열면 안 된다", () => {
    expect(execRuleKey("git status", "shell")).toBe("code.exec:shell:git status");
    expect(execRuleKey("git push --force", "shell")).toBe("code.exec:shell:git push");
    expect(execRuleKey("git status", "shell")).not.toBe(execRuleKey("git push", "shell"));
  });

  it("서브명령이 없는 도구는 이름만", () => {
    expect(execRuleKey("ls -la /tmp", "shell")).toBe("code.exec:shell:ls");
    expect(execRuleKey("/usr/bin/curl https://x", "shell")).toBe("code.exec:shell:curl");
  });

  it("앞에 붙은 환경변수 대입을 명령으로 오해하지 않는다", () => {
    expect(execRuleKey("FOO=1 BAR=2 npm run build", "shell")).toBe("code.exec:shell:npm run");
  });

  it("파이프 뒤는 보지 않는다 — 첫 명령이 규칙을 정한다", () => {
    expect(execRuleKey("cat a.txt | grep x", "shell")).toBe("code.exec:shell:cat");
  });

  it("주석과 빈 줄을 건너뛴다", () => {
    expect(execRuleKey("# 설명\n\nls -la", "shell")).toBe("code.exec:shell:ls");
  });

  it("플래그가 오는 서브명령 자리는 묶지 않는다", () => {
    expect(execRuleKey("npm --version", "shell")).toBe("code.exec:shell:npm");
  });

  it("AppleScript 는 조종하는 앱으로 묶는다", () => {
    expect(execRuleKey('tell application "Music" to play', "applescript")).toBe(
      "code.exec:applescript:Music"
    );
    expect(execRuleKey("set volume output volume 30", "applescript")).toBe(
      "code.exec:applescript"
    );
  });

  it("Python 은 코드가 매번 달라 언어 단위로만 묶는다", () => {
    expect(execRuleKey("print(1)", "python")).toBe("code.exec:python");
  });
});

describe("writeRuleKey", () => {
  it("파일이 아니라 부모 디렉토리로 묶는다", () => {
    expect(writeRuleKey("/Users/kim/notes/a.md")).toBe("fs.write:/Users/kim/notes");
    expect(writeRuleKey("/Users/kim/notes/b.md")).toBe(writeRuleKey("/Users/kim/notes/a.md"));
  });

  it("루트 직하도 다룬다", () => {
    expect(parentDir("/a.txt")).toBe("/");
  });
});

describe("승인 기억", () => {
  it("allow_once 는 아무것도 남기지 않는다", async () => {
    await remember("code.exec:shell:ls", "allow_once");
    expect(isAllowed("code.exec:shell:ls")).toBe(false);
  });

  it("allow_session 은 세션 동안만 유효하다", async () => {
    await remember("code.exec:shell:ls", "allow_session");
    expect(isAllowed("code.exec:shell:ls")).toBe(true);
    clearSessionRules();
    expect(isAllowed("code.exec:shell:ls")).toBe(false);
  });

  it("allow_always 는 세션 초기화에도 살아남고 목록에 나온다", async () => {
    await remember("code.exec:shell:git status", "allow_always");
    clearSessionRules();
    expect(isAllowed("code.exec:shell:git status")).toBe(true);
    expect(listAlwaysRules()).toContain("code.exec:shell:git status");

    await forgetAlwaysRule("code.exec:shell:git status");
    expect(isAllowed("code.exec:shell:git status")).toBe(false);
  });

  it("deny 는 승인으로 기록되지 않는다", async () => {
    await remember("code.exec:shell:rm", "deny");
    expect(isAllowed("code.exec:shell:rm")).toBe(false);
  });
});

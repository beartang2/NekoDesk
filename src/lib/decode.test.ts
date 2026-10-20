import { describe, it, expect } from "vitest";
import { decode } from "./decode";

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const b64url = (s: string) => b64(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("decode", () => {
  it("JWT — header·payload 를 풀고 exp 를 날짜로", () => {
    const token = `${b64url('{"alg":"HS256","typ":"JWT"}')}.${b64url('{"sub":"neko","exp":1792400000}')}.sig`;
    const r = decode(token)!;
    expect(r.kind).toBe("JWT");
    expect(r.text).toContain('"sub": "neko"');
    expect(r.text).toMatch(/exp: 2026\. 10\./);
  });

  it("Unix 시간 — 초·밀리초, 엉뚱한 숫자는 아님", () => {
    expect(decode("1792400000")?.kind).toBe("Unix 시간");
    expect(decode("1792400000123")?.kind).toBe("Unix 시간");
    expect(decode("0101234567")).toBeNull(); // 1973년 — 전화번호일 가능성이 크다
    expect(decode("12345")).toBeNull();
  });

  it("한 줄 JSON 은 펴고, 이미 편 건 그대로 둔다", () => {
    expect(decode('{"a":1,"b":[1,2]}')?.text).toBe('{\n  "a": 1,\n  "b": [\n    1,\n    2\n  ]\n}');
    expect(decode('{\n  "a": 1\n}')).toBeNull();
  });

  it("URL 인코딩 — 끝이 잘린 %F 는 남기고 나머지는 푼다", () => {
    expect(decode("q=%EB%84%A4%EC%BD%94+%EA%B3%A0%EC%96%91%EC%9D%B4")).toEqual({ kind: "URL", text: "q=네코 고양이" });
    expect(decode("Hello%2C%20World%21%20%EC%95%88%EB%85%95%21%20%F")?.text).toBe("Hello, World! 안녕! %F");
  });

  it("16진수 — 띄어 쓴 것·이어 쓴 것, 끝이 잘린 반쪽 글자는 버린다", () => {
    expect(decode("48 65 6c 6c 6f 2c 20 ec 95 88 eb 85")?.text).toBe("Hello, 안");
    expect(decode("48656c6c6f20eb84a4ecbd94")).toEqual({ kind: "16진수", text: "Hello 네코" });
    expect(decode("41424344")).toBeNull(); // 그냥 숫자일 수 있다
    expect(decode("deadbeefcafe")).toBeNull(); // 글이 안 나온다
  });

  it("Base64 — 읽을 수 있는 글이 나올 때만", () => {
    expect(decode(b64("안녕, 네코야!"))).toEqual({ kind: "Base64", text: "안녕, 네코야!" });
    expect(decode(b64('{"k":"v"}'))?.text).toBe('{\n  "k": "v"\n}');
    expect(decode("HelloWorld12")).toBeNull();
    expect(decode("그냥 문장이야")).toBeNull();
    expect(decode("This is plain English text")).toBeNull();
  });

  it("Base64 — 사이에 딴 글자가 끼어도 조각마다 푼다", () => {
    expect(decode(`${b64("Hello, 네코! ")}🚀${b64(" 123")}`)?.text).toBe("Hello, 네코! 🚀 123");
  });
});

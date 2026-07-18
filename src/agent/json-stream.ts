/**
 * agentStep 의 응답은 JSON 한 덩어리다:
 *   {"thought": "...", "tool": "none", "finalAnswer": "안녕!"}
 *
 * 예전에는 JSON 이 전부 도착할 때까지 기다렸다가 `finalAnswer.split("")` 로
 * 글자 하나씩 yield 했다. 그래서 (1) 생성이 끝날 때까지 화면이 비어 있었고
 * (2) 글자 수만큼 리렌더가 터졌다. 로컬 llama.cpp 처럼 느린 백엔드에서는 치명적이다.
 *
 * 이 스트리머는 JSON 이 완성되기 전에 지정한 문자열 필드의 내용을 도착하는 대로
 * 디코딩해 내보낸다. 추가 LLM 호출 없이 진짜 스트리밍이 된다.
 */

const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

const isHighSurrogate = (c: number) => c >= 0xd800 && c <= 0xdbff;
const HEX = /^[0-9a-fA-F]{4}$/;

export interface JsonStringFieldStreamer {
  /** 새로 도착한 원본 조각을 밀어넣고, 새로 디코딩된 텍스트를 돌려받는다. */
  push(chunk: string): string;
  /** 필드의 닫는 따옴표까지 읽었는지. */
  isDone(): boolean;
}

export function createJsonStringFieldStreamer(field: string): JsonStringFieldStreamer {
  const key = `"${field}"`;
  let phase: "seeking" | "reading" | "done" = "seeking";
  let buf = "";

  /** `"field"` 뒤의 `: "` 까지 소비한다. 아직 다 안 왔으면 false. */
  function seek(): boolean {
    const at = buf.indexOf(key);
    if (at === -1) {
      // 키가 청크 경계에 걸쳐 있을 수 있으니 꼬리만 남긴다.
      if (buf.length > key.length) buf = buf.slice(-(key.length - 1));
      return false;
    }
    let i = at + key.length;
    while (i < buf.length && /\s/.test(buf[i])) i++;
    if (i >= buf.length) return false;
    if (buf[i] !== ":") {
      // "finalAnswer" 라는 문자열이 값 안에 있었을 뿐이다. 지나친다.
      buf = buf.slice(at + key.length);
      return false;
    }
    i++;
    while (i < buf.length && /\s/.test(buf[i])) i++;
    if (i >= buf.length) return false;
    if (buf[i] !== '"') {
      buf = buf.slice(i);
      return false;
    }
    buf = buf.slice(i + 1);
    phase = "reading";
    return true;
  }

  /** 열린 문자열에서 완전히 디코딩 가능한 만큼만 뽑는다. 불완전한 이스케이프는 버퍼에 남긴다. */
  function read(): string {
    let out = "";
    let i = 0;
    while (i < buf.length) {
      const c = buf[i];

      if (c === '"') {
        phase = "done";
        buf = "";
        return out;
      }

      if (c !== "\\") {
        out += c;
        i++;
        continue;
      }

      // 이스케이프 — 뒤에 최소 1글자가 더 있어야 한다.
      if (i + 1 >= buf.length) break;
      const e = buf[i + 1];

      if (e !== "u") {
        out += ESCAPES[e] ?? e;
        i += 2;
        continue;
      }

      // \uXXXX — 4자리 hex 가 다 와야 한다.
      if (i + 6 > buf.length) break;
      const hex = buf.slice(i + 2, i + 6);
      if (!HEX.test(hex)) {
        // 망가진 이스케이프. 원문 그대로 흘려보낸다.
        out += buf.slice(i, i + 2);
        i += 2;
        continue;
      }
      const code = parseInt(hex, 16);

      if (!isHighSurrogate(code)) {
        out += String.fromCharCode(code);
        i += 6;
        continue;
      }

      // 서로게이트 페어 — 짝이 올 때까지 기다린다. 반쪽만 내보내면 �로 렌더된다.
      if (i + 12 > buf.length) break;
      if (buf[i + 6] !== "\\" || buf[i + 7] !== "u") {
        out += String.fromCharCode(code);
        i += 6;
        continue;
      }
      const lowHex = buf.slice(i + 8, i + 12);
      if (!HEX.test(lowHex)) {
        out += String.fromCharCode(code);
        i += 6;
        continue;
      }
      out += String.fromCharCode(code, parseInt(lowHex, 16));
      i += 12;
    }

    buf = buf.slice(i);
    return out;
  }

  return {
    push(chunk: string): string {
      if (phase === "done") return "";
      buf += chunk;
      if (phase === "seeking" && !seek()) return "";
      return read();
    },
    isDone: () => phase === "done",
  };
}

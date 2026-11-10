import Anthropic from "@anthropic-ai/sdk";
import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * 공식 TypeScript SDK 클라이언트. 요청을 만들고 스트림·오류·재시도를 다루는 건 SDK 이고,
 * 실제 전송만 Rust(`claude_proxy`)가 한다 — Rust 가 키체인의 키를 붙여 api.anthropic.com 으로
 * 보낸다. 그래서 SDK 에 주는 키는 가짜고, 진짜 키는 화면(webview)에 한 번도 오지 않는다.
 *
 * `dangerouslyAllowBrowser` 는 "브라우저에 진짜 키를 두지 마라" 는 경고를 끄는 스위치다.
 * 여기 있는 키는 아무 데도 쓸 수 없는 자리표시라 그 위험이 없다.
 */

type ProxyEvent =
  | { event: "head"; data: { status: number; headers: [string, string][] } }
  | { event: "chunk"; data: { text: string } }
  | { event: "end"; data?: undefined }
  | { event: "error"; data: { message: string } };

export function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("요청을 멈췄어.", "AbortError");
}

/** SDK 의 `fetch` 자리. 요청을 Rust 로 넘기고, 받은 상태·헤더·본문 조각으로 표준 Response 를 만든다. */
export function proxyFetch(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, name) => { headers[name] = value; });
  const body = typeof init.body === "string" ? init.body : "";
  const signal = init.signal ?? undefined;
  const id = crypto.randomUUID();
  const encoder = new TextEncoder();

  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let settled = false;
  const cancel = () => void invoke("claude_cancel", { id }).catch(() => {});
  const stream = new ReadableStream<Uint8Array>({
    start(c) { ctrl = c; },
    // 읽는 쪽이 그만두면(멈춤 버튼, SDK 의 abort) 서버 쪽 생성도 끊는다.
    cancel() {
      if (!settled) cancel();
      settled = true;
    },
  });

  return new Promise<Response>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    let started = false;
    const finish = () => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: Error) => {
      if (settled) return;
      finish();
      if (started) ctrl.error(err);
      else reject(err);
    };
    const onAbort = () => {
      cancel();
      fail(abortError(signal!));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const channel = new Channel<ProxyEvent>();
    channel.onmessage = (ev) => {
      if (settled) return;
      switch (ev.event) {
        case "head":
          started = true;
          resolve(new Response(stream, { status: ev.data.status, headers: ev.data.headers }));
          break;
        case "chunk":
          ctrl.enqueue(encoder.encode(ev.data.text));
          break;
        case "end":
          finish();
          ctrl.close();
          break;
        case "error":
          fail(new TypeError(ev.data.message));
          break;
      }
    };

    invoke("claude_proxy", { id, path: url.pathname + url.search, headers, body, onEvent: channel })
      .catch((e) => fail(new TypeError(String(e))));
  });
}

let client: Anthropic | null = null;

export function claudeClient(): Anthropic {
  return (client ??= new Anthropic({ apiKey: "set-by-rust-proxy", dangerouslyAllowBrowser: true, fetch: proxyFetch }));
}

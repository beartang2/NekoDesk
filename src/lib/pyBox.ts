import nekoDraw from "../../src-tauri/src/exec/neko_draw.py?raw";

/**
 * 폰의 파이썬 실행(code.exec 의 python). 맥은 python3 하위 프로세스(src-tauri/src/exec)인데 iOS 는 프로세스를 못 띄워,
 * Pyodide(WASM CPython)를 앱에 묶어 돌린다 — 그림 도구 neko_draw.py 를 맥과 같은 파일 그대로 쓴다(유르미 그림체).
 *
 * 격리(모델이 쓴 코드가 앱에 닿지 않게):
 * - 숨은 iframe(srcdoc) 안의 Web Worker 에서 돈다. 워커엔 window·DOM·Tauri invoke 가 없다. 밖과는 postMessage 뿐이고,
 *   받는 쪽(여기)은 글·숫자만 꺼내 쓴다.
 * - iframe 의 CSP 가 워커에 그대로 걸린다: 네트워크 없음(connect-src 'none'), 밖의 스크립트 없음, 글을 코드로 돌리기(eval) 없음.
 *   Pyodide 파일은 앱 자산을 여기서 읽어 메시지로 건넨다 — 워커는 아무것도 내려받지 않는다.
 * - 파이썬에서 JS 로 가는 모듈(js·pyodide_js)을 지우고, 워커의 네트워크·저장소 전역(fetch·WebSocket·indexedDB …)도 지운다.
 * - 30초를 넘으면 iframe 째 없앤다(무한 루프). 2분 안 쓰면 내려놓는다(메모리).
 */
export interface PyResult { stdout: string; stderr: string; exit_code: number; truncated: boolean; image_data_url?: string }

const FILES = ["pyodide.mjs", "pyodide.asm.mjs", "pyodide.asm.wasm", "python_stdlib.zip", "pyodide-lock.json"] as const;
const RUN_MS = 30_000, START_MS = 90_000, IDLE_MS = 120_000;
/** 맥과 같은 출력 상한(src-tauri/src/exec/mod.rs MAX_OUTPUT) */
const MAX_OUTPUT = 4000;
/** 다시 띄운 워커에 되돌려 줄 파일(그림·그린 코드)의 크기 상한 */
const KEEP_BYTES = 2_000_000;

/**
 * 쓴 코드(/neko/run.py)를 돌리는 파이썬. 맥처럼 그린 코드를 NEKO_SOURCE 로 넣어 주고(neko_draw.save 가 .py 로 남긴다),
 * 오류는 쓴 코드의 줄부터 보이고, 끝난 값(exit code)을 돌려준다
 */
export const PY_BOOT = [
  "import os, sys, runpy, traceback",
  "os.environ['NEKO_SOURCE'] = open('/neko/run.py', encoding='utf-8').read()",
  "__neko_code = 0",
  "try:",
  "    runpy.run_path('/neko/run.py', run_name='__main__')",
  "except SystemExit as e:",
  "    __neko_code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)",
  "except BaseException as e:",
  "    tb = e.__traceback__",
  "    while tb is not None and tb.tb_frame.f_code.co_filename != '/neko/run.py':",
  "        tb = tb.tb_next",
  "    traceback.print_exception(type(e), e, tb)",
  "    __neko_code = 1",
  "sys.stdout.flush(); sys.stderr.flush()",
  "__neko_code",
].join("\n");

/** 워커 안에서 도는 코드. 번들러를 거치지 않는 글이다(CSP 가 blob: 만 허락한다) */
export const WORKER_SOURCE = String.raw`
const files = {};
let py = null, out = [], err = [], size = 0;
const blobUrl = (name) => URL.createObjectURL(new Blob([files[name]], { type: "text/javascript" }));
const push = (to) => (s) => { if (size < 200000) { to.push(s); size += s.length + 1; } };
const b64 = (bytes) => { let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(bin); };
const IMG = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };
const OUT = "/neko/out";
const BOOT = ${JSON.stringify(PY_BOOT)};

async function init(m) {
  Object.assign(files, m.files);
  // Pyodide 가 제 파일을 찾을 때만 쓰는 가짜 fetch: 받은 바이트를 돌려준다(진짜 네트워크는 CSP 가 막는다)
  self.fetch = async (u) => {
    const name = String(u).split("/").pop();
    if (!(name in files)) throw new TypeError("blocked");
    return new Response(files[name], { headers: { "content-type": name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } });
  };
  const { loadPyodide } = await import(blobUrl("pyodide.mjs"));
  const createPyodideModule = (await import(blobUrl("pyodide.asm.mjs"))).default;
  py = await loadPyodide({
    indexURL: "https://pyodide.invalid/",
    createPyodideModule,
    lockFileContents: JSON.parse(new TextDecoder().decode(files["pyodide-lock.json"])),
    stdout: (s) => push(out)(s),
    stderr: (s) => push(err)(s),
  });
  py.FS.mkdirTree("/neko/lib");
  py.FS.mkdirTree(OUT);
  py.FS.writeFile("/neko/lib/neko_draw.py", m.nekoDraw);
  for (const [name, text] of Object.entries(m.keep || {})) py.FS.writeFile(OUT + "/" + name, text);
  py.runPython("import sys, os\nsys.path.insert(0, '/neko/lib')\nos.chdir('" + OUT + "')");
  // 파이썬에서 JS 로 가는 길을 끊는다
  py.unregisterJsModule("js");
  py.unregisterJsModule("pyodide_js");
  py.runPython("for _m in ('js', 'pyodide_js'):\n    sys.modules.pop(_m, None)\ndel _m");
  for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "indexedDB", "caches", "BroadcastChannel", "Worker", "SharedWorker", "WebTransport"]) {
    for (let o = self; o; o = Object.getPrototypeOf(o)) { try { delete o[k]; } catch {} }
    try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch {}
  }
  for (const k of Object.keys(files)) delete files[k];
  self.postMessage({ type: "ready" });
}

/** 출력 폴더의 파일마다 고친 때·크기(이번 실행이 만들거나 바꾼 것을 가린다) */
function listing() {
  const seen = {};
  for (const name of py.FS.readdir(OUT)) {
    if (name === "." || name === "..") continue;
    const st = py.FS.stat(OUT + "/" + name);
    if (py.FS.isFile(st.mode)) seen[name] = [st.mtime.getTime ? st.mtime.getTime() : Number(st.mtime), st.size];
  }
  return seen;
}

function run(m) {
  out = []; err = []; size = 0;
  const before = listing();
  py.FS.writeFile("/neko/run.py", m.code);
  let code = 1;
  try { code = Number(py.runPython(BOOT)) || 0; } catch (e) { push(err)(String(e && e.message || e)); }
  // 이번에 만든 그림 중 가장 새것(맥의 collect_output_image 와 같다)과, 다시 띄울 때 되돌릴 글 파일들
  let image = null, newest = -1;
  const keep = {};
  for (const [name, [at, bytes]] of Object.entries(listing())) {
    const path = OUT + "/" + name, ext = name.split(".").pop().toLowerCase(), was = before[name];
    const made = !was || was[0] !== at || was[1] !== bytes;
    if (IMG[ext] && made && at >= newest && bytes <= 4000000) { newest = at; image = [path, IMG[ext]]; }
    if ((ext === "svg" || ext === "py") && bytes <= 400000) keep[name] = py.FS.readFile(path, { encoding: "utf8" });
  }
  self.postMessage({ type: "done", id: m.id, exit_code: code, stdout: out.join("\n"), stderr: err.join("\n"),
    image: image ? "data:" + image[1] + ";base64," + b64(py.FS.readFile(image[0])) : null, keep });
}

self.onmessage = (e) => {
  const m = e.data;
  if (m.type === "init") init(m).catch((x) => self.postMessage({ type: "error", error: String(x && x.message || x) }));
  else if (m.type === "run") { try { run(m); } catch (x) { self.postMessage({ type: "error", id: m.id, error: String(x && x.message || x) }); } }
};
`;

/** 워커를 품는 숨은 틀. 이 CSP 가 워커(blob: 로 띄운다)에 그대로 걸린다 */
export const FRAME_HTML = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; connect-src 'none'">
<script>
let worker = null;
addEventListener("message", (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (m.type === "init") {
    try {
      worker = new Worker(URL.createObjectURL(new Blob([m.worker], { type: "text/javascript" })), { type: "module" });
      worker.onmessage = (w) => parent.postMessage(w.data, "*");
      worker.onerror = (w) => parent.postMessage({ type: "error", error: "worker: " + (w.message || "") }, "*");
      worker.postMessage({ type: "init", files: m.files, nekoDraw: m.nekoDraw, keep: m.keep }, Object.values(m.files));
    } catch (x) { parent.postMessage({ type: "error", error: "frame: " + x }, "*"); }
  } else if (worker) worker.postMessage(m);
});
parent.postMessage({ type: "frame-ready" }, "*");
</script>`;

type Msg = { type?: unknown; id?: unknown; error?: unknown; exit_code?: unknown; stdout?: unknown; stderr?: unknown; image?: unknown; keep?: unknown };
interface Box { frame: HTMLIFrameElement; send(m: unknown, transfer?: Transferable[]): void; on: ((m: Msg) => void) | null; stop(): void }

let box: Promise<Box> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let idle: ReturnType<typeof setTimeout> | undefined;
let runId = 0;
/** 지난 실행들이 남긴 그림·코드(이름 → 글). 워커를 다시 띄울 때 되돌려, 앞서 그린 것을 고쳐 다시 돌릴 수 있게 */
let kept: Record<string, string> = {};

const text = (v: unknown, max = 400_000): string => (typeof v === "string" ? v.slice(0, max) : "");
function clip(s: string): [string, boolean] {
  const chars = Array.from(s);
  return chars.length <= MAX_OUTPUT ? [s, false] : [chars.slice(0, MAX_OUTPUT).join("") + "…(잘림)", true];
}

function start(): Promise<Box> {
  return new Promise<Box>((resolve, reject) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.display = "none";
    frame.srcdoc = FRAME_HTML;
    const b: Box = {
      frame,
      on: null,
      send: (m, transfer) => frame.contentWindow?.postMessage(m, "*", transfer ?? []),
      stop: () => { window.removeEventListener("message", listen); frame.remove(); clearTimeout(timer); },
    };
    const fail = (why: string) => { b.stop(); reject(new Error(why)); };
    const timer = setTimeout(() => fail("파이썬을 준비하지 못했습니다(시간 초과)."), START_MS);
    const listen = (e: MessageEvent) => {
      if (e.source !== frame.contentWindow) return;
      const m = (e.data ?? {}) as Msg;
      if (m.type === "frame-ready") {
        // 앱에 묶인 Pyodide 파일(폰 빌드에만 있다 — vite.config.ts)을 읽어 건넨다
        Promise.all(FILES.map(async (n) => {
          const res = await fetch(`${import.meta.env.BASE_URL}pyodide/${n}`);
          if (!res.ok) throw new Error(`pyodide/${n} ${res.status}`);
          return [n, await res.arrayBuffer()] as const;
        })).then((got) => {
          const files = Object.fromEntries(got);
          b.send({ type: "init", worker: WORKER_SOURCE, files, nekoDraw, keep: kept }, Object.values(files));
        }, (x) => fail(`파이썬 파일을 읽지 못했습니다(${x instanceof Error ? x.message : x}).`));
      } else if (m.type === "ready") { clearTimeout(timer); resolve(b); }
      else if (m.type === "error" && !b.on) fail(`파이썬을 준비하지 못했습니다(${text(m.error, 300)}).`);
      else b.on?.(m);
    };
    window.addEventListener("message", listen);
    document.body.appendChild(frame);
  });
}

function drop(): void {
  clearTimeout(idle);
  const b = box;
  box = null;
  void b?.then((x) => x.stop(), () => {});
}

async function runOnce(code: string): Promise<PyResult> {
  clearTimeout(idle);
  let b: Box;
  try { b = await (box ??= start()); } catch (x) {
    box = null;
    return { stdout: "", stderr: x instanceof Error ? x.message : String(x), exit_code: -1, truncated: false };
  }
  const id = ++runId;
  const m = await new Promise<Msg | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), RUN_MS);
    b.on = (msg) => { if (msg.id === id) { clearTimeout(timer); resolve(msg); } };
    b.send({ type: "run", id, code });
  });
  b.on = null;
  if (!m || m.type !== "done") {
    drop(); // 멈춘 워커는 틀째 없앤다. 다음 실행은 새로 띄운다
    return { stdout: "", stderr: m ? `실행하지 못했습니다(${text(m.error, 300)}).` : "실행 시간 초과 (30초)", exit_code: -1, truncated: false };
  }
  // 워커가 준 것은 글·숫자만 꺼내 쓴다
  if (m.keep && typeof m.keep === "object") {
    const next: Record<string, string> = {};
    let bytes = 0;
    for (const [name, body] of Object.entries(m.keep as Record<string, unknown>)) {
      if (typeof body !== "string" || !/^[^/\\]{1,120}\.(svg|py)$/.test(name) || (bytes += body.length) > KEEP_BYTES) continue;
      next[name] = body;
    }
    kept = next;
  }
  idle = setTimeout(drop, IDLE_MS);
  const [stdout, cutOut] = clip(text(m.stdout)), [stderr, cutErr] = clip(text(m.stderr));
  const image = typeof m.image === "string" && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(m.image) ? m.image : undefined;
  return { stdout, stderr, exit_code: Number.isInteger(m.exit_code) ? (m.exit_code as number) : -1, truncated: cutOut || cutErr, ...(image ? { image_data_url: image } : {}) };
}

/** 파이썬 코드를 격리된 곳에서 돌린다. 한 번에 하나씩(먼저 온 것부터) */
export function runPython(code: string): Promise<PyResult> {
  const next = queue.then(() => runOnce(code));
  queue = next.catch(() => {});
  return next;
}

/** 시험용: 워커를 내려놓고 남긴 파일을 비운다 */
export function resetPyBox(): void { drop(); kept = {}; }

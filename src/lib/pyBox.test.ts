import { beforeAll, describe, expect, it } from "vitest";
import nekoDraw from "../../src-tauri/src/exec/neko_draw.py?raw";
import { loadPyodide, type PyodideInterface } from "pyodide";
import { FRAME_HTML, PY_BOOT, WORKER_SOURCE } from "./pyBox";

/**
 * 폰의 파이썬 실행(lib/pyBox): 앱에 묶는 것과 같은 Pyodide 로 맥의 그림 도구(neko_draw.py)를 그대로 돌린다.
 * 여기선 Node 에서 Pyodide 를 직접 띄워 워커가 하는 일(코드 넣기 → 돌리기 → 그림·출력)을 같은 글(PY_BOOT)로 본다.
 * 격리(iframe CSP·워커)는 브라우저에서만 볼 수 있어 글로 확인한다
 */
let py: PyodideInterface;
const out: string[] = [], err: string[] = [];
const run = (code: string): number => {
  out.length = 0; err.length = 0;
  py.FS.writeFile("/neko/run.py", code);
  return Number(py.runPython(PY_BOOT));
};

beforeAll(async () => {
  py = await loadPyodide({ stdout: (s) => out.push(s), stderr: (s) => err.push(s) });
  py.FS.mkdirTree("/neko/lib");
  py.FS.mkdirTree("/neko/out");
  py.FS.writeFile("/neko/lib/neko_draw.py", nekoDraw);
  py.runPython("import sys, os\nsys.path.insert(0, '/neko/lib')\nos.chdir('/neko/out')");
  py.unregisterJsModule("js");
  py.unregisterJsModule("pyodide_js");
  py.runPython("for _m in ('js', 'pyodide_js'):\n    sys.modules.pop(_m, None)");
}, 60_000);

describe("폰의 파이썬 실행", () => {
  it("맥과 같은 그림 도구로 그린다: SVG 와 그린 코드(.py)가 남고, 같은 이름은 _2 로", () => {
    const code = 'from neko_draw import *\nsave("cat", shape(ring(768, 800, 330), "#F2A65A"), eyes(650, 890, 760, 80))';
    expect(run(code)).toBe(0);
    expect(out.join("\n")).toBe("저장: cat.svg (코드: cat.py)");
    const svg = py.FS.readFile("/neko/out/cat.svg", { encoding: "utf8" });
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1536 1536"')).toBe(true);
    expect(svg).toContain('stroke="#141414"'); // 손그림 외곽선(neko_draw 의 INK)
    expect(py.FS.readFile("/neko/out/cat.py", { encoding: "utf8" })).toBe(code);
    expect(run(code)).toBe(0);
    expect(out.join("\n")).toContain("cat_2.svg");
  });

  it("오류는 쓴 코드의 줄부터 보이고 끝난 값이 1, sys.exit 은 그 값", () => {
    expect(run("x = 1\ny = x / 0")).toBe(1);
    const text = err.join("\n");
    expect(text).toContain('File "/neko/run.py", line 2');
    expect(text).toContain("ZeroDivisionError");
    expect(text).not.toContain("runpy");
    expect(run("def f(:\n    pass")).toBe(1);
    expect(err.join("\n")).toContain("SyntaxError");
    expect(run("import sys\nprint('가')\nsys.exit(3)")).toBe(3);
    expect(out).toEqual(["가"]);
  });

  it("파이썬에서 JS·네트워크로 가는 모듈은 없다", () => {
    expect(run("import js")).toBe(1);
    expect(err.join("\n")).toContain("ModuleNotFoundError");
    expect(run("import pyodide_js")).toBe(1);
    expect(run("from pyodide.code import run_js\nrun_js('1')")).toBe(1);
  });

  it("틀의 CSP: 네트워크·밖의 스크립트·eval 없음. 워커는 네트워크 전역을 지운다", () => {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(FRAME_HTML)![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/https?:|\*/);
    for (const k of ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "indexedDB"]) expect(WORKER_SOURCE).toContain(`"${k}"`);
    expect(WORKER_SOURCE).toContain('unregisterJsModule("js")');
  });
});

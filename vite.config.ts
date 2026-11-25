import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { createReadStream, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 폰(iOS) 빌드에만 Pyodide(WASM 파이썬) 파일을 앱에 묶는다 — 폰의 code.exec(python)이 쓴다(src/lib/pyBox.ts).
 * CDN 에서 받지 않는다(오프라인·사생활). 필요한 다섯 파일만(약 13.5MB), 패키지는 없다. 맥 빌드엔 넣지 않는다.
 */
const PYODIDE_FILES: Record<string, string> = {
  "pyodide.mjs": "text/javascript",
  "pyodide.asm.mjs": "text/javascript",
  "pyodide.asm.wasm": "application/wasm",
  "python_stdlib.zip": "application/zip",
  "pyodide-lock.json": "application/json",
};
function pyodideFiles(): Plugin {
  const dir = resolve("node_modules/pyodide");
  return {
    name: "neko-pyodide",
    configureServer(server) {
      server.middlewares.use("/pyodide", (req, res, next) => {
        const name = (req.url ?? "").split("?")[0].replace(/^\//, "");
        if (!(name in PYODIDE_FILES)) return next();
        res.setHeader("content-type", PYODIDE_FILES[name]);
        createReadStream(resolve(dir, name)).pipe(res);
      });
    },
    generateBundle() {
      for (const name of Object.keys(PYODIDE_FILES)) this.emitFile({ type: "asset", fileName: `pyodide/${name}`, source: readFileSync(resolve(dir, name)) });
    },
  };
}

export default defineConfig(async () => ({
  plugins: [react(), ...(process.env.TAURI_ENV_PLATFORM === "ios" ? [pyodideFiles()] : [])],
  clearScreen: false,
  // Tauri CLI 가 빌드 때 주는 TAURI_ENV_PLATFORM 으로 폰(iOS)을 가른다(src/lib/platform.ts).
  envPrefix: ["VITE_", "TAURI_ENV_"],
  // 통합 테스트는 실제 llama-server 를 때리므로 기본 `npm test` 에서 뺀다.
  // `npm run test:integration` 으로 따로 돌린다.
  test: {
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
  server: {
    port: 1420,
    strictPort: true,
    // `tauri ios dev` 로 실제 폰에 띄울 때만 맥 주소로 연다(TAURI_DEV_HOST). 평소엔 localhost 만.
    host: process.env.TAURI_DEV_HOST || false,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));

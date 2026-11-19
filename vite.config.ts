import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],
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

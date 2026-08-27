import { defineConfig } from "vite";
import { configDefaults } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  // 통합 테스트는 실제 llama-server 를 때리므로 기본 `npm test` 에서 뺀다.
  // `npm run test:integration` 으로 따로 돌린다.
  test: {
    exclude: [...configDefaults.exclude, "**/*.integration.test.ts"],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));

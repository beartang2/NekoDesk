import { defineConfig } from "vitest/config";

/**
 * 통합 테스트 전용 설정. 기본 설정(vite.config.ts)은 `*.integration.test.ts` 를
 * 빼두기 때문에 여기서 그 파일들만 다시 집어넣는다.
 * 실제 llama-server 를 때리므로 느리다 — 타임아웃도 넉넉히 잡는다.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 240_000,
    hookTimeout: 30_000,
  },
});

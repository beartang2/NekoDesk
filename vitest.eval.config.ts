import { defineConfig } from "vitest/config";

// 실제 llama-server 에 붙는 평가 전용 설정. `npm test` 에는 포함되지 않는다.
export default defineConfig({
  test: {
    include: ["eval/**/*.eval.ts"],
    setupFiles: ["eval/setup.ts"],
    environment: "node",
    // 케이스들이 같은 모델을 쓰므로 순서대로 돌린다(동시에 보내면 서로 기다리며 시간만 왜곡된다).
    fileParallelism: false,
    testTimeout: 10 * 60_000,
    hookTimeout: 5 * 60_000,
  },
});

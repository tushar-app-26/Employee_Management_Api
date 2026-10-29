import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        setupFiles: ["tests/setup.ts"],
        env: { NODE_ENV: "test" },
        testTimeout: 15_000,
        hookTimeout: 30_000,
        fileParallelism: false,
    },
});

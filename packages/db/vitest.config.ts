import { defineConfig } from "vitest/config";

// The integration tests share one TEST_DATABASE_URL and each file wipes it, so files run one at a time.
export default defineConfig({ test: { fileParallelism: false } });

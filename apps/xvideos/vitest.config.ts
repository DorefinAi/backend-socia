import { defineConfig } from "vitest/config";

// One test file at a time, as the other packages
export default defineConfig({ test: { fileParallelism: false } });

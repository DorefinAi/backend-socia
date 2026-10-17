import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  // Bundle the workspace packages (they ship TypeScript source); npm packages stay external,
  // so every package the workspace code imports must be listed in this app's dependencies
  noExternal: [/^@socia\//],
  // CommonJS code that still ends up in the bundle needs a require
  banner: { js: 'import { createRequire as __socia_cr } from "node:module"; const require = __socia_cr(import.meta.url);' },
  clean: true,
  sourcemap: true,
});

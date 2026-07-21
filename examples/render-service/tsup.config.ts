/** Builds isolated Node and fully local browser bundles for the deployable demo. */
import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "examples/render-service/src/index.ts" },
    format: "esm",
    platform: "node",
    target: "node20",
    outDir: "examples/render-service/dist/server",
    clean: true,
    dts: false,
    sourcemap: true,
  },
  {
    entry: { client: "examples/render-service/src/app.tsx" },
    format: "iife",
    platform: "browser",
    target: "es2022",
    outDir: "examples/render-service/dist/public",
    clean: true,
    dts: false,
    minify: true,
    noExternal: [/.*/u],
  },
]);

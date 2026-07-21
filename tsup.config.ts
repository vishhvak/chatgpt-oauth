import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "app-server/index": "src/app-server/index.ts",
    "node/index": "src/node/index.ts",
    "react/index": "src/react/index.tsx",
    "react-native/index": "src/react-native/index.ts",
    "web/index": "src/web/index.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
  external: ["react", "react/jsx-runtime"],
});

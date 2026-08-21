import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "ai-sdk/index": "src/ai-sdk/index.ts",
    "app-server/index": "src/app-server/index.ts",
    "http/index": "src/http/index.ts",
    "next/index": "src/next/index.ts",
    "node/index": "src/node/index.ts",
    "react/index": "src/react/index.tsx",
    "react-native/index": "src/react-native/index.ts",
    "realtime/index": "src/realtime/index.ts",
    "web/index": "src/web/index.ts",
  },
  format: "esm",
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: true,
  external: ["react", "react/jsx-runtime"],
});

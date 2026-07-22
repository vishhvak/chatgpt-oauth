import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the package's own name to source so tests (and the example code they
// import) run against src without requiring a prior `pnpm build`/`dist`. Subpaths
// must precede the bare match; the array is evaluated in order.
const src = (path: string): string => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

export default defineConfig({
  // Worktrees under .claude/ are full checkouts; without this every suite runs once per worktree.
  test: { exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"] },
  resolve: {
    alias: [
      { find: "chatgpt-oauth/ai-sdk", replacement: src("ai-sdk/index.ts") },
      { find: "chatgpt-oauth/app-server", replacement: src("app-server/index.ts") },
      { find: "chatgpt-oauth/http", replacement: src("http/index.ts") },
      { find: "chatgpt-oauth/next", replacement: src("next/index.ts") },
      { find: "chatgpt-oauth/node", replacement: src("node/index.ts") },
      { find: "chatgpt-oauth/web", replacement: src("web/index.ts") },
      { find: "chatgpt-oauth/react-native", replacement: src("react-native/index.ts") },
      { find: "chatgpt-oauth/react", replacement: src("react/index.tsx") },
      { find: /^chatgpt-oauth$/, replacement: src("index.ts") },
    ],
  },
});

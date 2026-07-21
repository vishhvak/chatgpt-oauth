import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "examples/**/dist/**", "coverage/**", ".lavish/**", "consensus.html"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["test/fixtures/*.mjs"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);

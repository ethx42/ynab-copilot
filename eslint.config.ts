// ESLint 10 flat config — reads .ts config natively (jiti).
// Enforces the hexagon boundary: core/ports must NEVER import adapters.
// Source shape: typescript-eslint flat-config helper + eslint-plugin-boundaries@6 (element-types).
import type { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";
import prettier from "eslint-config-prettier";

// eslint-plugin-boundaries@6 ships no flat-config Plugin typings; assert the
// known shape so the typed `tseslint.config()` helper accepts it.
const boundariesPlugin = boundaries as unknown as ESLint.Plugin;

export default tseslint.config(
  { ignores: ["dist/**", "coverage/**", "node_modules/**", "tests/fixtures/**"] },
  // Type-checked rules apply ONLY to the typed source tree (src + tests).
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { boundaries: boundariesPlugin },
    settings: {
      "boundaries/elements": [
        { type: "core", pattern: "src/core/**" },
        { type: "ports", pattern: "src/ports/**" },
        { type: "adapters", pattern: "src/adapters/**" },
        { type: "config", pattern: "src/config/**" },
      ],
    },
    rules: {
      "boundaries/element-types": [
        "error",
        {
          default: "disallow",
          rules: [
            // core is PURE — may import only core + ports, NEVER adapters.
            { from: ["core"], allow: ["core", "ports"] },
            // ports — interfaces over pure types only.
            { from: ["ports"], allow: ["ports", "core"] },
            // adapters wire the impure edges — may import everything.
            { from: ["adapters"], allow: ["core", "ports", "adapters", "config"] },
            // config (composition root) — may import core/ports/config.
            { from: ["config"], allow: ["core", "ports", "config"] },
          ],
        },
      ],
    },
  },
  // MUST be last — disables formatting rules that fight Prettier.
  prettier,
);

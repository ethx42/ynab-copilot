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
      // Resolve TS ESM imports (`.js` specifiers → `.ts` files) so the boundary
      // rule can classify the import target into its hexagon tier.
      "import/resolver": { typescript: { project: "tsconfig.json" } },
      // `mode: "full"` matches the pattern against the whole file path so the
      // `src/<tier>/**` globs classify each file into its hexagon tier.
      "boundaries/elements": [
        { type: "core", mode: "full", pattern: "src/core/**" },
        { type: "ports", mode: "full", pattern: "src/ports/**" },
        { type: "adapters", mode: "full", pattern: "src/adapters/**" },
        { type: "config", mode: "full", pattern: "src/config/**" },
      ],
    },
    rules: {
      // v6 renamed `element-types` → `dependencies` and requires OBJECT selectors
      // (`{ from: { type }, allow: { to: { type } } }`) — string selectors are
      // treated as legacy and do NOT enforce.
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          rules: [
            // core is PURE — may import only core + ports, NEVER adapters.
            { from: { type: "core" }, allow: { to: { type: ["core", "ports"] } } },
            // ports — interfaces over pure types only.
            { from: { type: "ports" }, allow: { to: { type: ["ports", "core"] } } },
            // adapters wire the impure edges — may import everything.
            {
              from: { type: "adapters" },
              allow: { to: { type: ["core", "ports", "adapters", "config"] } },
            },
            // config (composition root) — may import core/ports/config.
            { from: { type: "config" }, allow: { to: { type: ["core", "ports", "config"] } } },
          ],
        },
      ],
    },
  },
  // MUST be last — disables formatting rules that fight Prettier.
  prettier,
);

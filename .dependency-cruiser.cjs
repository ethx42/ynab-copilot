// dependency-cruiser backstop — independent, graph-aware enforcement of the
// hexagon boundary (defense-in-depth alongside eslint-plugin-boundaries).
// Source shape: dependency-cruiser@17 rule schema.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "core-not-to-adapters",
      comment: "Pure core/ports must never import the impure adapters tier (hexagon integrity).",
      severity: "error",
      from: { path: "^src/(core|ports)" },
      to: { path: "^src/adapters" },
    },
    {
      name: "no-circular",
      comment: "Circular dependencies break the dependency graph and hide coupling.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
  },
};

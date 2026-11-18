/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["**/test/**/*.spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"],
  // Explicitly point ts-jest at our tsconfig so `module: NodeNext`
  // (which honours `package.json#exports` subpaths) is used for both
  // type-check and emit. Without this, ts-jest synthesises a CJS-style
  // tsconfig that doesn't see workspace subpath exports.
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: "<rootDir>/tsconfig.json",
        // isolatedModules makes ts-jest use the simpler transpiler instead
        // of the LanguageService — the LanguageService does NOT fully honour
        // `package.json#exports` for workspace subpath imports under
        // `module: NodeNext`, while the transpiler does.
        isolatedModules: true,
      },
    ],
  },
  // RT-1378: the shared Offer Engine package is run from its source here, so the api Jest lanes that
  // build only a few named workspaces (bc/db-integration, the CircleCI and Depot api runs) do not
  // need packages/offer-engine/dist. Production and typecheck still use the built dist.
  moduleNameMapper: {
    "^@data-pulse-2/offer-engine$": "<rootDir>/../../packages/offer-engine/src/index.ts",
  },
  // RT-815: one shared Postgres per run; each spec file clones its own
  // database from a migrated template (test/_helpers/postgres-container.ts).
  globalSetup: "<rootDir>/test/_helpers/jest-global-setup.ts",
  globalTeardown: "<rootDir>/test/_helpers/jest-global-teardown.ts",
  clearMocks: true,
  restoreMocks: true,
  testTimeout: 30000,
  verbose: false,
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.spec.ts",
    "!src/**/*.d.ts",
    "!src/main.ts",
  ],
  coverageThreshold: {
    global: {
      // #618 G2 — the 90 branch gate made CI drop --coverage entirely.
      // Floors are the CI-measured baseline of main with #625/#627 merged
      // (95.78% statements, 84.3% branches, lines >= 96). Ratchet them up as
      // the suite improves; never lower them to pass a PR.
      statements: 95,
      branches: 84,
      functions: 95,
      lines: 96,
    },
  },
};

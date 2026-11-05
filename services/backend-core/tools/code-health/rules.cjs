/* eslint-env node */
// RT-1198/RT-1199: size and complexity rules for Backend-Core, defined once.
// .eslintrc.cjs applies them as warnings, and tools/code-health/check.mjs counts them for the
// ratchet. CommonJS, because the ESLint 8 legacy config loads synchronously.

const SIZE_RULE_FILES = ["apps/*/src/**/*.ts", "packages/*/src/**/*.ts"];

const SIZE_RULE_IGNORES = ["**/__tests__/**", "**/*.spec.ts", "**/*.test.ts", "**/*.d.ts"];

const SIZE_RULES = {
  complexity: ["warn", { max: 15 }],
  "max-lines-per-function": ["warn", { max: 150, skipBlankLines: true, skipComments: true }],
  "max-lines": ["warn", { max: 800, skipBlankLines: true, skipComments: true }],
};

module.exports = { SIZE_RULE_FILES, SIZE_RULE_IGNORES, SIZE_RULES };

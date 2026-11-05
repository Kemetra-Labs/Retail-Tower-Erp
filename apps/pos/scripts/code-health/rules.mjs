// RT-1198: the size and complexity rules, shared by eslint.config.js (editor and `npm run lint`
// warnings) and scripts/check-code-health.mjs (the CI ratchet). They are warnings, not errors:
// the ratchet fails only when the number of warnings grows, so existing code is not blocked and
// new code cannot add to the debt.

/** Source globs the size/complexity rules apply to. Tests are long on purpose and are excluded. */
export const SIZE_RULE_FILES = ['src/**/*.{ts,tsx}'];

export const SIZE_RULE_IGNORES = [
  'src/**/__tests__/**',
  'src/**/*.test.ts',
  'src/**/*.test.tsx',
  'src/tests/**',
  'src/shared/api-types.ts',
];

export const SIZE_RULES = {
  complexity: ['warn', { max: 15 }],
  'max-lines-per-function': ['warn', { max: 150, skipBlankLines: true, skipComments: true }],
  'max-lines': ['warn', { max: 800, skipBlankLines: true, skipComments: true }],
};

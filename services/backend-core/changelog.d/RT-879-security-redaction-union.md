### Security
- RT-879: the Sentry scrubber (`packages/shared/src/observability/sentry.ts`) now masks every
  pattern that another runtime's scrubber masks (shared `rt879-redaction-vectors.json`): a
  two-segment JWT, the query or fragment of a scheme-less URL or path, the MariaDB
  `Duplicate entry` value, credential `key=value` pairs (token, password, secret, api key, DSN),
  `exception.type`, and the query of a URL frame filename. The 2,000-char scan cap is cut back to
  whitespace so it never splits a word.

### Changed
- RT-1587 `[GATED: contract]`, follow-up to the RT-1578 review (owner decision in chat 2026-11-24, Option B, recorded on
  RT-1587): `pos-availability.yaml` requires `nextCursor` to be a nonempty string or `null` (`minLength: 1`), as the
  request schema and the POS client already do, and its description now says that the success responses are
  `additionalProperties: false` while the error response stays the canonical, open envelope. No runtime change: the
  cursor is base64url JSON and is never empty.

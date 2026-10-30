### Removed
- RT-800 `[GATED]`, owner authorization 2026-10-29 (Clerk retired, no transition
  period; ADR on Confluence RETAIL 61702148): the Clerk identity adapter, the
  Clerk operator-token verifier, `packages/auth`'s `clerk-jwt` re-export and the
  `@clerk/backend` dependency. Descope is the only identity provider:
  `IDENTITY_PROVIDER` unset selects it, and any other value, including `clerk`,
  fails at boot. The shared identity-link tests now run through the Descope adapter.

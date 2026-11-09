/**
 * lab-fixtures constants — RT-1309 (S1 of RT-1308).
 *
 * The lab allowlists live in code, not in environment variables, so widening
 * them is a reviewed pull request (owner decision 2026-11-09). An environment
 * flag alone never makes a target "the lab".
 */

/** The opt-in flag the CLI requires (necessary, never sufficient). */
export const ENABLE_ENV = "RT_LAB_FIXTURES";
export const ENABLE_VALUE = "enabled";

/**
 * Independent lab attestation: the name the database server itself reports
 * (`current_database()`). Owner decision 2026-11-09: a production or pilot
 * database must never be named like this.
 */
export const LAB_DATABASE_NAMES: readonly string[] = ["rtlab"];

/** The Descope project the lab's `DESCOPE_PROJECT_ID` names. */
export const LAB_DESCOPE_PROJECT_IDS: readonly string[] = ["P3KyErdApJFbv0HMlZF6Vyagz2vo"];

/**
 * Synthetic tenants fixtures may be written into. Each must also carry
 * `SYNTHETIC_TENANT_MARKER` in its name at run time.
 */
export const LAB_FIXTURE_TENANT_IDS: readonly string[] = ["43437ec7-b3e2-4c12-8e32-8a0356bae8e5"];
export const SYNTHETIC_TENANT_MARKER = "(synthetic)";

/** Fixture identity namespace (no mail is ever sent: `.invalid` is reserved). */
export const FIXTURE_LOGIN_PREFIX = "rtfx-cashier-";
export const FIXTURE_EMAIL_DOMAIN = "fixtures.invalid";
export const FIXTURE_DISPLAY_PREFIX = "RT Fixture Cashier ";

/** S1 bound; 10 and 100 are planned (RT-1308), larger needs a new decision. */
export const MAX_FIXTURES = 100;

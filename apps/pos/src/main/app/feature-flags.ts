import type { AppConfig } from '../../shared/app-config.js';
import { getBakedLaneConfig } from '../config/lane-config.js';
import type { Lane } from '../config/lane-config.js';

/**
 * RT-162 (RT-160 FU-1: S-1 config module + H-1 fail-closed cashier profile).
 *
 * The one place the POS feature flags are parsed from the process environment.
 * Previously `src/main/index.ts` `getAppConfig()` repeated the same inline
 * truthy check five times; this module keeps those semantics exactly:
 *
 *   • the env-var names are the ops contract (unchanged);
 *   • truthy values are `1 | true | yes | on`, case-insensitive, trimmed;
 *   • anything else, or unset, is `false` — every flag is fail-closed,
 *     except `returns` (RT-1180, owner decision 2026-11-04): unset or blank is
 *     `true`, so a manager has returns from the first sign-in. An explicit
 *     `0 | false | no | off` is the device kill switch, and an unrecognised
 *     value still fails closed. The manager/admin role rule stays in
 *     `returns-service.ts`.
 *
 * It also owns the D-1 cashier-profile rule (owner decision, RT-160 comment
 * 10721): `PAYMENTS` on with `SALE_FINALIZATION` off is an INVALID profile.
 * In that mode 006 settles money while 008 writes no Sale row, receipt, sync
 * outbox entry or Backend-Core capture. Main refuses to start the cashier
 * rather than take money it cannot record. The decision is pure here; the
 * composition root logs it, shows a native dialog and exits.
 *
 * RT-1376 — one resolution point. Precedence: the environment, then the baked lane
 * default, then the switch's own default. A pilot-lane build (`lane-config.json`,
 * RT-1346) turns the four cashier switches (`cart`, `productSearch`, `payments`,
 * `saleFinalization`) on by default with the RT-1180 semantics: unset or blank is on,
 * truthy is on, an explicit `0 | false | no | off` is the support kill switch. Every
 * other switch keeps its own default, and any other lane (or no baked file) is exactly
 * as before. Every caller goes through `resolveFeatureFlags`; none parses
 * `process.env` itself (a test pins that).
 *
 * Deliberately NOT here: `SENTRY_DSN`, `POS_PULSE_FEATURE_SALE_TENDERS_SINCE` and
 * `POS_PULSE_FEATURE_SALE_RECEIPT_SINCE` (ISO instants with their own parsers in `sales-sync`), and the dev-only
 * `POS_PULSE_DEV_*` bypasses (each owns its own packaged-build guard).
 */

/** All nine feature flags, always present. Same shape as `AppConfig['features']`. */
export type FeatureFlags = Required<NonNullable<AppConfig['features']>>;

/** Flag → env-var name. The names are the contract for ops scripts. */
export const FEATURE_FLAG_ENV: Readonly<Record<keyof FeatureFlags, string>> = Object.freeze({
  cart: 'POS_PULSE_FEATURE_CART',
  payments: 'POS_PULSE_FEATURE_PAYMENTS',
  saleFinalization: 'POS_PULSE_FEATURE_SALE_FINALIZATION',
  productSearch: 'POS_PULSE_FEATURE_PRODUCT_SEARCH',
  voucherTender: 'POS_PULSE_FEATURE_VOUCHER_TENDER',
  returns: 'POS_PULSE_FEATURE_RETURNS',
  shiftCashup: 'POS_PULSE_FEATURE_SHIFT_CASHUP',
  saleVoid: 'POS_PULSE_FEATURE_SALE_VOID',
  cardTender: 'POS_PULSE_FEATURE_CARD_TENDER',
});

const TRUTHY_VALUES: ReadonlySet<string> = new Set(['1', 'true', 'yes', 'on']);

/** The shared truthy parser. Unset or unrecognised → `false` (fail-closed). */
export function isTruthyFlag(raw: string | undefined): boolean {
  return typeof raw === 'string' && TRUTHY_VALUES.has(raw.trim().toLowerCase());
}

const FALSY_VALUES: ReadonlySet<string> = new Set(['0', 'false', 'no', 'off']);

/**
 * RT-1180 default-on parser. Unset or blank → `true`; truthy → `true`;
 * explicit falsy → `false` (kill switch); anything else → `false`.
 */
export function isDefaultOnFlag(raw: string | undefined): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '') return true;
  if (TRUTHY_VALUES.has(value)) return true;
  if (FALSY_VALUES.has(value)) return false;
  return false;
}

/** The lane whose build carries the pilot cashier profile (RT-1376). */
const PILOT_LANE: Lane = 'pilot';

/** Cashier switches that default to on on a pilot-lane build. */
const PILOT_DEFAULT_ON_KEYS: ReadonlySet<keyof FeatureFlags> = new Set([
  'cart',
  'productSearch',
  'payments',
  'saleFinalization',
]);

type Env = Readonly<Record<string, string | undefined>>;

function parseSwitch(key: keyof FeatureFlags, env: Env, lane: Lane | undefined): boolean {
  const raw = env[FEATURE_FLAG_ENV[key]];
  if (key === 'returns') return isDefaultOnFlag(raw);
  if (lane === PILOT_LANE && PILOT_DEFAULT_ON_KEYS.has(key)) return isDefaultOnFlag(raw);
  return isTruthyFlag(raw);
}

/**
 * Parse every feature flag from an environment for a lane. Pure: callers in main use
 * `resolveFeatureFlags`, which supplies `process.env` and the baked lane.
 */
export function parseFeatureFlags(env: Env, lane?: Lane): FeatureFlags {
  return {
    cart: parseSwitch('cart', env, lane),
    payments: parseSwitch('payments', env, lane),
    saleFinalization: parseSwitch('saleFinalization', env, lane),
    productSearch: parseSwitch('productSearch', env, lane),
    voucherTender: parseSwitch('voucherTender', env, lane),
    returns: parseSwitch('returns', env, lane),
    shiftCashup: parseSwitch('shiftCashup', env, lane),
    saleVoid: parseSwitch('saleVoid', env, lane),
    cardTender: parseSwitch('cardTender', env, lane),
  };
}

/**
 * THE resolution point (RT-1376): `process.env`, then the baked lane default, then the
 * switch's own default. Read per call, so a kill switch and the baked holder behave as
 * the live environment read did before.
 */
export function resolveFeatureFlags(): FeatureFlags {
  return parseFeatureFlags(process.env, getBakedLaneConfig()?.lane);
}

export type CashierProfileRefusalReason = 'payments_without_sale_finalization';

export type CashierProfileAssessment =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: CashierProfileRefusalReason };

/**
 * D-1 coherence check. Only the money combination is decided here; other
 * combinations (e.g. product search without cart) are UX coherence and keep
 * their existing semantics.
 */
export function assessCashierProfile(flags: FeatureFlags): CashierProfileAssessment {
  if (flags.payments && !flags.saleFinalization) {
    return { ok: false, reason: 'payments_without_sale_finalization' };
  }
  return { ok: true };
}

export interface CashierProfileRefusal {
  readonly title: string;
  readonly body: string;
}

/**
 * Copy for the native startup dialog. Arabic first (the cashier/store reads
 * it), then one technical line naming the env vars for whoever provisions the
 * terminal. Contains no secrets — flag names only.
 */
export function describeCashierProfileRefusal(
  reason: CashierProfileRefusalReason,
): CashierProfileRefusal {
  return CASHIER_PROFILE_REFUSALS[reason];
}

/**
 * Right-to-left mark. The native dialog lays each paragraph out LTR, so a
 * trailing RLM keeps an Arabic line's sentence-final "." inside the RTL run
 * (otherwise it renders at the visual right edge, where the sentence starts).
 */
const RLM = '‏';

const CASHIER_PROFILE_REFUSALS: Readonly<
  Record<CashierProfileRefusalReason, CashierProfileRefusal>
> = {
  payments_without_sale_finalization: {
    title: 'إعداد نقطة البيع غير صالح',
    body: [
      `الدفع مفعّل بينما تسجيل البيع معطّل، فلن يُسجَّل أي بيع ولن يُطبع إيصال.${RLM}`,
      `لن تعمل نقطة البيع بهذا الإعداد. اتصل بمسؤول النظام لتصحيح إعداد الجهاز.${RLM}`,
      '',
      `${FEATURE_FLAG_ENV.payments} is on while ${FEATURE_FLAG_ENV.saleFinalization} is off. ` +
        'Turn both on, or both off to stop POS payment-taking.',
    ].join('\n'),
  },
};

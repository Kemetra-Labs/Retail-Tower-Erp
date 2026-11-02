/**
 * RT-1074 pure rules of the per-product stock-level editor. No React, no fetch.
 * The contract is Backend-Core's `catalog/stock-levels.yaml` (RT-1064 decision
 * record TH-1 to TH-5, served since RT-1066):
 *
 *   - TH-2: a level is a required `reorderLevel` and an optional
 *     `criticalLevel`, each a strictly positive EXACT decimal string (up to 15
 *     integer and 4 fractional digits), with `criticalLevel <= reorderLevel`
 *     (equal allowed). Values are never parsed to a number and never rounded:
 *     every check here works on the digits. The server stays the judge and
 *     answers 422 `critical_above_reorder`, which lands on the critical field.
 *   - TH-4 roles: the tenant level is written by `owner` / `tenant_admin`;
 *     a store level also by an in-scope `store_manager`. The UI mirrors this so
 *     nobody is offered what would be refused; the API stays the authority.
 *   - TH-4 concurrency: every write carries `expectedUpdatedAt` (the active
 *     level's `updatedAt`, or `null` on a set when none was seen). A 409
 *     `stale_write` reloads and says so; nothing is overwritten.
 *   - TH-4 idempotency: each set intent gets a fresh `Idempotency-Key`; the key
 *     is reused only to retry that exact intent (same scope, same body).
 *
 * Helpers return message keys, never copy (RT-399).
 */
import type { BannerVariant } from "@/components/Banner";
import type { MessageKey } from "@/i18n";
import type {
  ProductStockLevels,
  SetStockLevelRequest,
  StoreStockLevel,
  TenantStockLevel,
} from "@/lib/stock-level-queries";

// --- Roles (TH-4) ------------------------------------------------------------------------------

/** Roles the read accepts. */
export const STOCK_LEVEL_READ_ROLES = ["owner", "tenant_admin", "store_manager"] as const;
/** Roles the tenant-level writes accept (the CAT-W1 product write roles). */
export const TENANT_LEVEL_WRITE_ROLES = ["owner", "tenant_admin"] as const;
/** Roles the store-level writes accept, for a store in the caller's scope (CAT-W2). */
export const STORE_LEVEL_WRITE_ROLES = ["owner", "tenant_admin", "store_manager"] as const;

function hasRole(roles: readonly string[], role: string | null | undefined): boolean {
  return roles.includes(role ?? "");
}

/** Mirrors the API's read roles; not an authorization decision. */
export function canReadStockLevels(role: string | null | undefined): boolean {
  return hasRole(STOCK_LEVEL_READ_ROLES, role);
}

/** Mirrors the API's tenant-level write roles; not an authorization decision. */
export function canWriteTenantLevel(role: string | null | undefined): boolean {
  return hasRole(TENANT_LEVEL_WRITE_ROLES, role);
}

/** Mirrors the API's store-level write roles; the store must also be in scope. */
export function canWriteStoreLevel(role: string | null | undefined): boolean {
  return hasRole(STORE_LEVEL_WRITE_ROLES, role);
}

// --- Exact decimal strings (TH-2) --------------------------------------------------------------

/** The contract's `LevelQuantity`: strictly positive, 1-15 integer and 0-4 fractional digits. */
export const LEVEL_PATTERN = /^(?!0+(?:\.0+)?$)[0-9]{1,15}(\.[0-9]{1,4})?$/;

const ARABIC_INDIC_ZERO = 0x0660;
const EXTENDED_ARABIC_INDIC_ZERO = 0x06f0;

/**
 * What the person typed, as the wire string: the ends trimmed, Arabic-Indic
 * (٠-٩) and Extended Arabic-Indic (۰-۹) digits written as 0-9, and the Arabic
 * decimal separator «٫» as ".". Each character maps to exactly one character:
 * the value is spelled differently, never changed, parsed or rounded.
 */
export function normalizeLevel(raw: string): string {
  return raw
    .trim()
    .replace(/[٠-٩۰-۹]/g, (digit) => {
      const code = digit.charCodeAt(0);
      return String(
        code -
          (code >= EXTENDED_ARABIC_INDIC_ZERO ? EXTENDED_ARABIC_INDIC_ZERO : ARABIC_INDIC_ZERO),
      );
    })
    .replace(/٫/g, ".");
}

/** True when `value` (already normalized) is a valid wire level. */
export function isLevel(value: string): boolean {
  return LEVEL_PATTERN.test(value);
}

/** Integer digits without leading zeros, fraction padded to 4 digits: comparable as text. */
function canonical(value: string): { int: string; frac: string } {
  const [rawInt = "", rawFrac = ""] = value.split(".");
  const int = rawInt.replace(/^0+(?=\d)/, "");
  return { int, frac: rawFrac.padEnd(4, "0") };
}

/**
 * Compare two valid levels exactly, digit by digit: -1, 0 or 1. No float is
 * ever made, so "0.0001" vs "0.0002" and 15-digit values compare correctly.
 */
export function compareLevels(a: string, b: string): -1 | 0 | 1 {
  const x = canonical(a);
  const y = canonical(b);
  if (x.int.length !== y.int.length) return x.int.length < y.int.length ? -1 : 1;
  if (x.int !== y.int) return x.int < y.int ? -1 : 1;
  if (x.frac !== y.frac) return x.frac < y.frac ? -1 : 1;
  return 0;
}

/** Why one typed level cannot be sent, or undefined. `required` is the reorder level. */
export function levelProblem(raw: string, required: boolean): MessageKey | undefined {
  const value = normalizeLevel(raw);
  if (value === "") return required ? "catalog.stockLevels.error.reorderRequired" : undefined;
  if (!/^[0-9]+(\.[0-9]+)?$/.test(value)) return "catalog.stockLevels.error.format";
  const { int, frac } = canonical(value);
  if (/^0+$/.test(int) && /^0+$/.test(frac)) return "catalog.stockLevels.error.positive";
  if ((value.split(".")[1] ?? "").length > 4) return "catalog.stockLevels.error.precision";
  if ((value.split(".")[0] ?? "").length > 15) return "catalog.stockLevels.error.tooLarge";
  return isLevel(value) ? undefined : "catalog.stockLevels.error.format";
}

// --- The form ------------------------------------------------------------------------------------

/** What the person sees and edits, raw. `critical` "" is "no critical level". */
export interface LevelFormValues {
  reorder: string;
  critical: string;
}

export interface LevelFormErrors {
  reorder?: MessageKey;
  critical?: MessageKey;
}

/** The active level as form values; no level is two empty fields. Shown exactly as read. */
export function levelValuesOf(level: TenantStockLevel | StoreStockLevel | null): LevelFormValues {
  return { reorder: level?.reorderLevel ?? "", critical: level?.criticalLevel ?? "" };
}

/** Each field on its own, then the cross-field rule `critical <= reorder` (equal allowed). */
export function validateLevelForm(values: LevelFormValues): LevelFormErrors {
  const errors: LevelFormErrors = {};
  const reorder = levelProblem(values.reorder, true);
  const critical = levelProblem(values.critical, false);
  if (reorder) errors.reorder = reorder;
  if (critical) errors.critical = critical;
  const r = normalizeLevel(values.reorder);
  const c = normalizeLevel(values.critical);
  if (!reorder && !critical && c !== "" && compareLevels(c, r) > 0) {
    errors.critical = "catalog.stockLevels.error.criticalAboveReorder";
  }
  return errors;
}

export function hasErrors(errors: LevelFormErrors): boolean {
  return errors.reorder !== undefined || errors.critical !== undefined;
}

/** The set body: both values as typed (normalized only), and the precondition. */
export function buildSetBody(
  values: LevelFormValues,
  expectedUpdatedAt: string | null,
): SetStockLevelRequest {
  const critical = normalizeLevel(values.critical);
  return {
    expectedUpdatedAt,
    reorderLevel: normalizeLevel(values.reorder),
    criticalLevel: critical === "" ? null : critical,
  };
}

/**
 * Nothing to save: a level exists and both values are exactly equal to it
 * (digit-exact, so "5" equals "5.0000"; no rounding is involved).
 */
export function isUnchanged(
  level: TenantStockLevel | StoreStockLevel | null,
  body: SetStockLevelRequest,
): boolean {
  if (level === null) return false;
  if (compareLevels(level.reorderLevel, body.reorderLevel) !== 0) return false;
  const a = level.criticalLevel;
  const b = body.criticalLevel ?? null;
  if (a === null || b === null) return a === b;
  return compareLevels(a, b) === 0;
}

/**
 * After a `stale_write` the levels are read again. A field the person changed
 * keeps what they typed; a field they did not touch takes the fresh value, so
 * the next save cannot silently put back somebody else's change.
 */
export function mergeLevelReload(
  oldBase: LevelFormValues,
  typed: LevelFormValues,
  freshBase: LevelFormValues,
): LevelFormValues {
  return {
    reorder: typed.reorder === oldBase.reorder ? freshBase.reorder : typed.reorder,
    critical: typed.critical === oldBase.critical ? freshBase.critical : typed.critical,
  };
}

// --- Scope ----------------------------------------------------------------------------------------

/** Which level a write targets. */
export type LevelTarget = { kind: "tenant" } | { kind: "store"; storeId: string };

/** The active level of a target in a read, or null when it has none. */
export function levelOf(
  levels: ProductStockLevels,
  target: LevelTarget,
): TenantStockLevel | StoreStockLevel | null {
  if (target.kind === "tenant") return levels.tenantLevel;
  return levels.storeLevels.find((s) => s.storeId === target.storeId) ?? null;
}

/** The precondition of a write: the active level's `updatedAt`, or `null` when none was seen. */
export function expectedUpdatedAtOf(level: { updatedAt: string } | null): string | null {
  return level?.updatedAt ?? null;
}

/** A body that lacks the lists (or a non-object) is a product with no levels. */
export function normalizeLevels(productId: string, data: unknown): ProductStockLevels {
  const body = (data ?? {}) as Partial<ProductStockLevels>;
  return {
    productId: body.productId ?? productId,
    tenantLevel: body.tenantLevel ?? null,
    storeLevels: Array.isArray(body.storeLevels) ? body.storeLevels : [],
  };
}

// --- The Idempotency-Key lifecycle (TH-4) --------------------------------------------------------

/** One set intent: its fingerprint (scope and body) and the key that names it to the server. */
export interface KeyedIntent {
  fingerprint: string;
  key: string;
}

/** The identity of a set intent: the target and the exact body. */
export function intentFingerprint(target: LevelTarget, body: SetStockLevelRequest): string {
  return JSON.stringify([
    target.kind === "store" ? target.storeId : null,
    body.expectedUpdatedAt,
    body.reorderLevel,
    body.criticalLevel ?? null,
  ]);
}

/** A v4 UUID: 36 printable ASCII characters, inside the contract's `^[\x21-\x7E]{16,128}$`. */
export function newIntentKey(): string {
  return crypto.randomUUID();
}

/**
 * The key for this intent. A retry of the SAME intent (after a dropped
 * response, a 5xx, a 425 or a 429) reuses the previous key, so the server
 * replays instead of writing twice; a different intent gets a new key.
 */
export function keyForIntent(
  previous: KeyedIntent | undefined,
  fingerprint: string,
  mint: () => string = newIntentKey,
): KeyedIntent {
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, key: mint() };
}

// --- The failure of a write ----------------------------------------------------------------------

export type LevelWriteOp = "set" | "retire";

export type LevelWriteRender =
  /** 409 `stale_write`: the level changed since it was read. The editor reloads and says so. */
  | { kind: "stale"; requestId?: string }
  /** 409 `product_retired` (set only): the item is retired; its levels are read-only. */
  | { kind: "retired"; requestId?: string }
  /** 422 `critical_above_reorder` (set only): shown on the critical field. */
  | { kind: "critical"; requestId?: string }
  /** 404 on a retire: the level is already gone; the levels are read again. */
  | { kind: "gone"; requestId?: string }
  /** 425 `idempotency_in_progress`: the same set is still running; retry with the same key. */
  | { kind: "in-progress"; retryAfterSec: number }
  /** Every other failure: a persistent banner in the editor. */
  | { kind: "banner"; variant: BannerVariant; messageKey: MessageKey; requestId?: string };

export interface LevelWriteFailure {
  op: LevelWriteOp;
  status: number;
  /** `error.code` of the envelope, when there was one. */
  code?: string;
  requestId?: string;
  /** The 425 body's `retryAfterSec`, when there was one. */
  retryAfterSec?: number;
}

function banner(
  variant: BannerVariant,
  messageKey: MessageKey,
  requestId: string | undefined,
): LevelWriteRender {
  return { kind: "banner", variant, messageKey, requestId };
}

function conflict({ op, code, requestId }: LevelWriteFailure): LevelWriteRender {
  if (code === "stale_write") return { kind: "stale", requestId };
  if (code === "product_retired" && op === "set") return { kind: "retired", requestId };
  if (code === "idempotency_key_conflict") {
    return banner("danger", "catalog.stockLevels.error.keyConflict", requestId);
  }
  return banner("danger", "catalog.stockLevels.error.conflict", requestId);
}

function badRequest({ code, requestId }: LevelWriteFailure): LevelWriteRender {
  // A missing or malformed key is the client's fault, not the person's input:
  // the next attempt gets a new key (see `keepsKey`).
  if (code === "idempotency_key_required" || code === "idempotency_key_malformed") {
    return banner("danger", "catalog.write.error.server", requestId);
  }
  return banner("danger", "catalog.stockLevels.error.validation", requestId);
}

/** Where a failed write is shown. */
export function mapLevelWriteError(failure: LevelWriteFailure): LevelWriteRender {
  const { op, status, code, requestId } = failure;
  switch (status) {
    case 400:
      return badRequest(failure);
    case 401:
      return banner("danger", "catalog.write.error.session", requestId);
    case 403:
      return banner(
        "danger",
        code === "origin_rejected"
          ? "catalog.write.error.origin"
          : "catalog.stockLevels.error.forbidden",
        requestId,
      );
    case 404:
      return op === "retire"
        ? { kind: "gone", requestId }
        : banner("danger", "catalog.stockLevels.error.notFound", requestId);
    case 409:
      return conflict(failure);
    case 422:
      return op === "set"
        ? { kind: "critical", requestId }
        : banner("danger", "catalog.stockLevels.error.validation", requestId);
    case 425:
      return { kind: "in-progress", retryAfterSec: Math.max(1, failure.retryAfterSec ?? 1) };
    case 429:
      return banner("warning", "catalog.write.error.rateLimited", requestId);
    default:
      return banner("danger", "catalog.write.error.server", requestId);
  }
}

/**
 * Whether a failed set keeps its key for the next attempt. Only a failure that
 * may not have been decided (5xx, 425 in progress, 429) is a retry of the same
 * intent; every other answer is final, so the next attempt is a new intent.
 */
export function keepsKey(status: number): boolean {
  return status >= 500 || status === 425 || status === 429;
}

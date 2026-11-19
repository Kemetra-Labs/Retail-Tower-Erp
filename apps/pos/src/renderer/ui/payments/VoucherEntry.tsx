import { useMemo, useRef, useState, type JSX } from 'react';

import type { TenderApplyRequest, TenderApplyResponse } from '../../../shared/bridge-api.js';
import { touchTarget } from '../tokens/touch.js';
import { PinnedPrimary } from './CheckoutActionBar.js';
import { parseCurrencyToMinor } from './parse-currency-to-minor.js';
import { VOUCHER_REFUSAL_GENERIC_COPY, voucherRefusalCopy } from './voucher-refusal-copy.js';
import { VoucherForfeitPrompt } from './VoucherForfeitPrompt.js';
import { normalizeNumericInput } from '../forms/normalize-digits.js';

/**
 * 006-payments-tender Slice 4 T290 — <VoucherEntry>.
 *
 * Wave 5c renderer surface. Mounts inside PaymentSurface when the
 * cashier selects the `internal_voucher` tender slot. Calls
 * `tender.apply` with `tender_type: 'internal_voucher'` + the typed
 * voucher code + the cashier-supplied amount.
 *
 * The bridge handler (T263 — extended in Wave 4) routes the call to
 * the voucher-authority-client V-A client (T250 — Wave 3) which validates
 * against Data-Pulse-2. On success the line is persisted with state
 * `applied` and the intent token stays main-side (FR-017).
 *
 * SECURITY:
 *   - Refusal copy (RT-1331, owner decision 2026-11-19, superseding
 *     F-A4B-003's one-generic-line rule): each refusal reason maps to a
 *     closed Arabic line in `voucher-refusal-copy.ts`. The structured
 *     `refusal.reason` NEVER enters the DOM, and a cross-tenant code reads
 *     like an unknown one.
 *   - FR-017: no voucher tokens, no voucher balance, no holder PII,
 *     no campaign metadata in props or rendered output. The voucher
 *     code IS rendered (it's the cashier's own input).
 *   - Money is integer minor units only (Constitution §P9 / P-II).
 *   - No factor-distinguishing copy on refusal (FR-022 / NFR-003 /
 *     PR-2 inherited from 004).
 */

export interface VoucherEntryProps {
  /** Remaining cart balance in minor units; defines the cashier's amount ceiling. */
  remainingBalanceMinor: number;
  /** Payment attempt id from the main process. */
  paymentAttemptId: string;
  /** Bridge callback. Receives a fully-formed TenderApplyRequest. */
  tenderApply: (req: TenderApplyRequest) => Promise<TenderApplyResponse>;
  /** Fires with the `{ kind: 'ok', ... }` response on successful apply. */
  onApplied?: (response: Extract<TenderApplyResponse, { kind: 'ok' }>) => void;
}

const VOUCHER_CODE_PATTERN = /^[A-Z0-9_-]+$/;

/**
 * The forfeit a `forfeit_confirmation_required` answer asks the cashier to confirm, or
 * null for any other answer. An answer without a positive safe integer is not a prompt
 * (there is nothing to confirm): it falls through to the generic refusal, failing closed.
 */
function usableForfeit(response: TenderApplyResponse): number | null {
  if (response.kind !== 'forfeit_confirmation_required') {
    return null;
  }
  const forfeited = response.forfeited_amount_minor;
  return Number.isSafeInteger(forfeited) && forfeited > 0 ? forfeited : null;
}

/** A confirmation the cashier has been asked for; edits to the inputs discard it. */
interface PendingForfeit {
  readonly forfeitedMinor: number;
  readonly amountMinor: number;
  readonly code: string;
}

/*
 * 022 Phase C — `formatMinorUnits` was removed with the duplicate
 * `.amount-due-card`. It existed solely to render that panel's value; the
 * voucher path displays no money of its own (the applied indicator is a check
 * mark, and FR-017 forbids surfacing a voucher balance). `PaymentSurface` owns
 * the amount due and does its own formatting.
 */

function generateIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

export function VoucherEntry({
  remainingBalanceMinor,
  paymentAttemptId,
  tenderApply,
  onApplied,
}: Readonly<VoucherEntryProps>): JSX.Element {
  const [voucherCode, setVoucherCode] = useState<string>('');
  const [rawAmountInput, setRawAmountInput] = useState<string>('');
  // The Arabic line for the refusal on screen, or null (RT-1331: per reason, never the code).
  const [refusalCopy, setRefusalCopy] = useState<string | null>(null);
  const [isApplying, setIsApplying] = useState<boolean>(false);
  const [appliedOk, setAppliedOk] = useState<boolean>(false);
  const [pendingForfeit, setPendingForfeit] = useState<PendingForfeit | null>(null);

  // CR-1 (PR #226): React's `disabled` reflects state asynchronously,
  // so two rapid clicks can dispatch two bridge calls before
  // `isApplying` re-renders the button. Because each submission
  // generates a FRESH UUID v4 idempotency_key, the main-process
  // §P5 dedup would NOT collapse the duplicates — each call looks
  // like a distinct intent. The synchronous ref-lock guards against
  // double-fire deterministically; the render-state `disabled` stays
  // as secondary UX feedback.
  const submitLockRef = useRef<boolean>(false);

  // RT-1331: bumped on every accepted edit of the code or the amount. A forfeit answer
  // belongs to the input that was sent; if either input changed while the request was in
  // flight, the answer is discarded (nothing was persisted for it), so a prompt is never
  // restored for a code or amount the cashier no longer sees, and confirming can never
  // acknowledge input other than what is on screen.
  const inputRevisionRef = useRef<number>(0);
  const noteInputEdited = (): void => {
    inputRevisionRef.current += 1;
    if (pendingForfeit !== null) setPendingForfeit(null);
  };

  const amountAppliedMinor = useMemo(() => parseCurrencyToMinor(rawAmountInput), [rawAmountInput]);

  const codeIsWellFormed = voucherCode.length >= 3 && VOUCHER_CODE_PATTERN.test(voucherCode);
  // CR-2 (PR #226): defence-in-depth — a malformed `remainingBalanceMinor`
  // prop (NaN / Infinity / negative / non-integer) would otherwise let
  // `amountIsWellFormed` evaluate `<=` against a non-money value. The
  // upstream caller (PaymentSurface) already guards this, but the
  // Constitution §P-II posture is "validate at every layer that
  // consumes money".
  const remainingBalanceIsValid =
    Number.isSafeInteger(remainingBalanceMinor) && remainingBalanceMinor >= 0;
  const amountIsWellFormed =
    remainingBalanceIsValid &&
    amountAppliedMinor !== null &&
    amountAppliedMinor > 0 &&
    amountAppliedMinor <= remainingBalanceMinor;

  const canSubmit = codeIsWellFormed && amountIsWellFormed && !isApplying;

  /**
   * One `tender.apply` round trip. Without `forfeitAckMinor` main may answer
   * `forfeit_confirmation_required` (RT-1331); with it, main applies the line only when
   * the forfeit it just saw still equals the amount the cashier confirmed, else it asks
   * again with the new amount. Every call carries a FRESH idempotency key: the first
   * answer persisted nothing, so there is nothing to replay.
   */
  const send = (amount: number, code: string, forfeitAckMinor?: number): void => {
    // Synchronous ref-lock first — beats React's render-state lag
    // against rapid double-clicks.
    if (submitLockRef.current) {
      return;
    }
    submitLockRef.current = true;
    const sentRevision = inputRevisionRef.current;
    setRefusalCopy(null);
    setIsApplying(true);
    void (async (): Promise<void> => {
      try {
        const response = await tenderApply({
          payment_attempt_id: paymentAttemptId,
          tender_type: 'internal_voucher',
          amount_applied_minor: amount,
          voucher_code: code,
          ...(forfeitAckMinor !== undefined ? { voucher_forfeit_ack_minor: forfeitAckMinor } : {}),
          idempotency_key: generateIdempotencyKey(),
        });
        if (response.kind === 'ok') {
          setPendingForfeit(null);
          setAppliedOk(true);
          onApplied?.(response);
          return;
        }
        const forfeitedMinor = usableForfeit(response);
        if (forfeitedMinor !== null) {
          if (sentRevision === inputRevisionRef.current) {
            setPendingForfeit({ forfeitedMinor, amountMinor: amount, code });
          }
          return;
        }
        // RT-1331: the refusal's own Arabic line. The structured `response.reason` is
        // looked up, never rendered. A forfeit answer without a usable amount has no
        // reason and lands on the generic line: it fails closed. The line states a fact
        // about the code that was sent, so a refusal that arrives after the cashier edited
        // the code or the amount is dropped, like a stale forfeit answer above.
        setPendingForfeit(null);
        if (sentRevision === inputRevisionRef.current) {
          setRefusalCopy(voucherRefusalCopy(response.kind === 'refused' ? response.reason : null));
        }
      } catch {
        // A rejected bridge call (IPC error / main-process crash /
        // timeout) MUST NOT leave the surface stuck in `isApplying`.
        // The generic refusal line — error details stay upstream.
        setPendingForfeit(null);
        setRefusalCopy(VOUCHER_REFUSAL_GENERIC_COPY);
      } finally {
        setIsApplying(false);
        submitLockRef.current = false;
      }
    })();
  };

  const handleSubmit = (): void => {
    // Use the raw `amountAppliedMinor` null-check as the guard — this
    // narrows the type cleanly. `canSubmit` is a downstream boolean
    // derived from the same value plus the upper-bound check; checking
    // both `amountAppliedMinor !== null` AND `canSubmit` gives the
    // narrowing without tripping eslint's no-unnecessary-condition.
    if (amountAppliedMinor === null || !canSubmit) {
      return;
    }
    send(amountAppliedMinor, voucherCode);
  };

  const handleForfeitConfirm = (): void => {
    if (pendingForfeit === null) {
      return;
    }
    send(pendingForfeit.amountMinor, pendingForfeit.code, pendingForfeit.forfeitedMinor);
  };

  return (
    <section className="voucher-entry" data-testid="voucher-entry" aria-label="تطبيق القسيمة">
      {/*
        022 Phase C — the amount due is NOT rendered here; `PaymentSurface` owns
        it as the surface's dominant numeric (FR-16). See the equivalent note in
        `CashEntry.tsx` for the full rationale. `remainingBalanceMinor` is still
        received and still used; only the duplicate presentation is gone.
      */}

      {/*
        v3.5 tender-slots / tender-row layout for the voucher path.
        SECURITY invariants (FR-017; refusal copy per RT-1331):
          - The voucher code IS rendered (cashier's own input).
          - No voucher balance, holder PII, or campaign metadata in props or DOM.
          - Refusals render a closed per-reason line (`voucher-refusal-copy.ts`), never a code.
          - Client-side voucher lookup is FORBIDDEN — validity is resolved
            MAIN-SIDE via the V-A client. No VOUCHERS table, no voucherKnown.
      */}
      <div className="v5-entry-slots">
        {/* Voucher code row — voucher-field wraps the input + applied indicator */}
        <div className="v5-entry-row">
          <span className="v5-entry-row__label">رمز القسيمة</span>
          <span className="v5-entry-row__value">
            <span className="voucher-field">
              <input
                type="text"
                data-testid="voucher-entry-code-input"
                dir="ltr"
                placeholder="VCH-000"
                aria-label="رمز القسيمة"
                value={voucherCode}
                onChange={(e) => {
                  // Voucher codes are upper-case per receipt convention.
                  setVoucherCode(e.target.value.toUpperCase());
                  if (refusalCopy !== null) setRefusalCopy(null);
                  if (appliedOk) setAppliedOk(false);
                  noteInputEdited();
                }}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                inputMode="text"
                aria-invalid={voucherCode.length > 0 && !codeIsWellFormed ? 'true' : undefined}
              />
              {/* SECURITY: appliedOk is set only by the bridge ok response.
                  It does NOT reflect any client-side table lookup. */}
              {appliedOk && (
                <span className="voucher-applied voucher-applied--ok" aria-label="تم تطبيق القسيمة">
                  ✓
                </span>
              )}
            </span>
          </span>
        </div>

        {/* Amount-to-apply row */}
        <div className="v5-entry-row">
          <label
            className="v5-entry-row__label voucher-entry__label"
            htmlFor="voucher-amount-input"
          >
            المبلغ المطبّق (<span dir="ltr">EGP</span>)
          </label>
          <span className="v5-entry-row__value">
            <input
              id="voucher-amount-input"
              data-scan-refuse="amount"
              type="text"
              data-testid="voucher-entry-amount-input"
              value={rawAmountInput}
              onChange={(e) => {
                const next = normalizeNumericInput(e.target.value);
                if (next === '' || /^\d*\.?\d{0,2}$/.test(next)) {
                  setRawAmountInput(next);
                  if (refusalCopy !== null) setRefusalCopy(null);
                  noteInputEdited();
                }
              }}
              inputMode="numeric"
              autoComplete="off"
              aria-invalid={rawAmountInput.length > 0 && !amountIsWellFormed ? 'true' : undefined}
            />
          </span>
        </div>
      </div>

      {/* Voucher code error: shown when code length >= 2 but malformed (not well-formed).
          SECURITY: this is a FORMAT error only, NOT a validity signal.
          The bridge is the only authority on voucher validity. */}
      {voucherCode.length > 0 && !codeIsWellFormed && (
        <output className="voucher-error">رمز القسيمة غير صالح: يجب ألا يقل عن 3 أحرف.</output>
      )}

      {/* Voucher hint: generic input guidance, no demo codes (SECURITY). */}
      <p className="voucher-hint">أدخل رمز القسيمة والمبلغ المطلوب تطبيقه، ثم اضغط «تطبيق».</p>

      <PinnedPrimary>
        {pendingForfeit === null ? (
          <button
            type="button"
            className="voucher-entry__confirm v5-btn v5-btn--primary v5-btn--commit"
            data-testid="voucher-entry-confirm"
            style={{ minHeight: touchTarget.commit }}
            disabled={!canSubmit}
            aria-disabled={!canSubmit ? 'true' : undefined}
            onClick={handleSubmit}
          >
            تطبيق القسيمة
          </button>
        ) : (
          <VoucherForfeitPrompt
            forfeitedMinor={pendingForfeit.forfeitedMinor}
            busy={isApplying}
            onConfirm={handleForfeitConfirm}
            onCancel={() => {
              setPendingForfeit(null);
            }}
          />
        )}
        {isApplying && (
          <div data-testid="voucher-entry-applying" aria-busy="true">
            جارٍ التطبيق…
          </div>
        )}

        {refusalCopy !== null && (
          <div data-testid="voucher-entry-refused" role="alert">
            {refusalCopy}
          </div>
        )}
      </PinnedPrimary>
    </section>
  );
}

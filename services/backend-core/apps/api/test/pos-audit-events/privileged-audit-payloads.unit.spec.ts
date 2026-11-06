/**
 * RT-1230 (RT-160 D-2; Jira RT-1230 comments 15798 and 15800) — the payload
 * rules of the privileged POS audit categories
 * (`pos-audit-events.openapi.yaml` 1.3.0-draft). Each valid fixture is the
 * shape the POS writes today; each rule has a closed key set.
 */
import { POS_AUDIT_ACTION_CATEGORIES } from "../../src/pos-audit-events/dto";
import {
  isPrivilegedPayloadValid,
  PRIVILEGED_AUDIT_CATEGORIES,
} from "../../src/pos-audit-events/privileged-audit-payloads";
import { loadOpenApiContracts } from "../../src/openapi/loader";

type Payload = Record<string, unknown>;

interface ContractDoc {
  info?: { version?: string; description?: string };
  components?: {
    schemas?: Record<string, { properties?: Record<string, { enum?: string[]; description?: string }> }>;
  };
}

function contract(): ContractDoc | undefined {
  return loadOpenApiContracts().find((c) => c.id === "pos-audit-events.openapi")?.document as
    | ContractDoc
    | undefined;
}

const UUID = "0195b200-0000-7000-8000-000000001230";
const AT = "2026-11-06T18:00:00.000Z";

/** The POS payload of each RT-1230 category, as its emitter builds it. */
const VALID_PRIVILEGED_PAYLOADS: Record<string, Payload> = {
  "manager_approval.granted": {
    approval_id: UUID,
    action_kind: "recovery.cancel_attempt",
    subject_ref: UUID,
    reason_code: "customer_left",
  },
  "manager_approval.refused": { action_kind: "sale.void", subject_ref: UUID },
  "payment.recovery_completed": { payment_attempt_id: UUID, cart_id: UUID, approval_id: UUID },
  "payment.recovery_cancelled": {
    payment_attempt_id: UUID,
    cart_id: UUID,
    approval_id: UUID,
    cash_returned_confirmed: true,
    card_void_confirmed_on_terminal: false,
  },
  "cart.held_cancelled_by_manager": { cart_id: UUID, approval_id: UUID, kind: "handed_off", parked: false },
  "cart.cancel.post_handoff": { cart_id: UUID, handoff_action_id: UUID, approval_id: UUID },
  "sale.receipt.manual_override": { sale_id: UUID, print_event_id: UUID },
  "sale.void.requested": {
    void_id: UUID,
    sale_id: UUID,
    amount_minor: 12500,
    currency_code: "EGP",
    business_date: "2026-11-06",
    approval_id: UUID,
    policy_version: "rt114-2026-10-07",
    approved_at: AT,
    requester_user_id: UUID,
  },
  "payment.force_failed": {
    force_failed_at: AT,
    force_fail_attribution_operator_id: "user_clerk_manager",
    original_cashier_operator_id: "user_clerk_cashier",
  },
  "tender.reversed": {
    tender_line_id: UUID,
    payment_attempt_id: UUID,
    tender_type: "internal_voucher",
    reversed_at: AT,
    attribution_operator_id: "user_clerk_cashier",
    manual_void_required: false,
  },
  "tender.reversal_pending": {
    tender_line_id: UUID,
    payment_attempt_id: UUID,
    tender_type: "internal_voucher",
    reversal_pending_since: AT,
    attribution_operator_id: "user_clerk_cashier",
  },
};

/** One malformed value per category (beyond the generic unknown/missing-key checks). */
const MALFORMED: ReadonlyArray<[string, string, Payload]> = [
  ["manager_approval.granted", "a free-text reason", { reason_code: "the customer left" }],
  ["manager_approval.granted", "a spaced action kind", { action_kind: "sale void" }],
  ["manager_approval.refused", "a subject ref with spaces", { subject_ref: "cart one" }],
  ["payment.recovery_completed", "a numeric cart id", { cart_id: 12 }],
  ["payment.recovery_cancelled", "a string flag", { cash_returned_confirmed: "yes" }],
  ["cart.held_cancelled_by_manager", "an unknown kind", { kind: "parked" }],
  ["cart.cancel.post_handoff", "an empty approval id", { approval_id: "" }],
  ["sale.receipt.manual_override", "a non-ASCII id", { print_event_id: "رقم" }],
  ["sale.void.requested", "a negative amount", { amount_minor: -1 }],
  ["sale.void.requested", "a fractional amount", { amount_minor: 1.5 }],
  ["sale.void.requested", "a lower-case currency", { currency_code: "egp" }],
  ["sale.void.requested", "an impossible business date", { business_date: "2026-02-30" }],
  ["sale.void.requested", "a free-text policy version", { policy_version: "policy of today" }],
  ["payment.force_failed", "a non-timestamp", { force_failed_at: "yesterday" }],
  ["tender.reversed", "an unknown tender type", { tender_type: "cheque" }],
  ["tender.reversed", "a malformed pending-since", { reversal_pending_since: "soon" }],
  ["tender.reversal_pending", "a missing operator", { attribution_operator_id: undefined }],
];

describe("RT-1230 — catalogue", () => {
  it("adds exactly the 11 owner-approved categories", () => {
    expect(PRIVILEGED_AUDIT_CATEGORIES).toEqual([
      "manager_approval.granted",
      "manager_approval.refused",
      "payment.recovery_completed",
      "payment.recovery_cancelled",
      "cart.held_cancelled_by_manager",
      "cart.cancel.post_handoff",
      "sale.receipt.manual_override",
      "sale.void.requested",
      "payment.force_failed",
      "tender.reversed",
      "tender.reversal_pending",
    ]);
  });

  it("keeps the 7 existing categories first and unchanged, then appends the new ones", () => {
    expect(POS_AUDIT_ACTION_CATEGORIES).toEqual([
      "shift.open",
      "shift.close",
      "shift.forced_close",
      "operator.session.takeover",
      "cashier.pin.reset",
      "cashier.pin.unlock",
      "cart.discount.manager_authorized",
      ...PRIVILEGED_AUDIT_CATEGORIES,
    ]);
  });

  it("does not centralize routine or not-yet-approved POS categories (D-2)", () => {
    for (const local of [
      "operator.session.locked",
      "operator.session.unlocked",
      "sale.finalized",
      "payment.settled",
      "tender.applied",
      "sale.drawer.opened",
      "manager_credential.revoked",
      "cashier.pin.provisioned",
      "cart.discount.above_threshold",
      "sale.receipt.reprinted",
      "sale.history.reprinted",
      "drawer.no_sale",
    ]) {
      expect(POS_AUDIT_ACTION_CATEGORIES).not.toContain(local);
    }
  });

  it("the contract is 1.3.0-draft and its enum is the runtime catalogue, in order", () => {
    const doc = contract();
    expect(doc?.info?.version).toBe("1.3.0-draft");
    const item = doc?.components?.schemas?.["AuditEventItem"];
    expect(item?.properties?.["action_category"]?.enum).toEqual([...POS_AUDIT_ACTION_CATEGORIES]);
  });

  it("the contract names every new payload shape and documents schema_violation as non-retryable", () => {
    const doc = contract();
    const payload = (doc?.components?.schemas?.["AuditEventItem"]?.properties?.["payload"]?.description ?? "")
      .replace(/\s+/g, " ");
    for (const category of PRIVILEGED_AUDIT_CATEGORIES) expect(payload).toContain(`${category}:`);
    expect(payload).toContain("RT-1230 categories (RT-160 D-2): each key set is CLOSED");
    const rejected = (doc?.components?.schemas?.["RejectedEvent"]?.properties?.["category"]?.description ?? "")
      .replace(/\s+/g, " ");
    expect(rejected).toContain("`schema_violation` is NON-RETRYABLE");
  });
});

describe("RT-1230 — accepted payloads", () => {
  it.each(Object.entries(VALID_PRIVILEGED_PAYLOADS))("%s: the POS payload is accepted", (category, payload) => {
    expect(isPrivilegedPayloadValid(category, payload)).toBe(true);
  });

  it("accepts the optional fields when absent (cart.cancel.post_handoff by a manager)", () => {
    const { approval_id: _omitted, ...managerCancel } = VALID_PRIVILEGED_PAYLOADS["cart.cancel.post_handoff"] as Payload;
    expect(isPrivilegedPayloadValid("cart.cancel.post_handoff", managerCancel)).toBe(true);
  });

  it("accepts tender.reversed with the preserved reversal_pending_since", () => {
    const payload = { ...VALID_PRIVILEGED_PAYLOADS["tender.reversed"], reversal_pending_since: AT };
    expect(isPrivilegedPayloadValid("tender.reversed", payload)).toBe(true);
  });

  it("accepts the device-sentinel actor and an ISO-timestamp print event id (POS id alphabet)", () => {
    expect(
      isPrivilegedPayloadValid("sale.receipt.manual_override", { sale_id: UUID, print_event_id: AT }),
    ).toBe(true);
    expect(
      isPrivilegedPayloadValid("tender.reversal_pending", {
        ...VALID_PRIVILEGED_PAYLOADS["tender.reversal_pending"],
        attribution_operator_id: "system:device",
      }),
    ).toBe(true);
  });

  it("has no rule for a category outside RT-1230 (other checks own it)", () => {
    expect(isPrivilegedPayloadValid("shift.close", { anything: 1 })).toBe(true);
  });
});

describe("RT-1230 — refused payloads", () => {
  it.each(Object.entries(VALID_PRIVILEGED_PAYLOADS))("%s: an unknown key is refused (closed key set)", (category, payload) => {
    expect(isPrivilegedPayloadValid(category, { ...payload, note: "free text" })).toBe(false);
  });

  it.each(Object.entries(VALID_PRIVILEGED_PAYLOADS))("%s: each required key missing is refused", (category, payload) => {
    const optional = new Set(["approval_id", "reversal_pending_since"]);
    for (const key of Object.keys(payload)) {
      if (category === "cart.cancel.post_handoff" && optional.has(key)) continue;
      const { [key]: _dropped, ...rest } = payload;
      expect(isPrivilegedPayloadValid(category, rest)).toBe(false);
    }
  });

  it.each(MALFORMED)("%s: %s is refused", (category, _name, change) => {
    const payload = { ...VALID_PRIVILEGED_PAYLOADS[category], ...change };
    expect(isPrivilegedPayloadValid(category, payload)).toBe(false);
  });

  it("an empty payload is refused for every RT-1230 category", () => {
    for (const category of PRIVILEGED_AUDIT_CATEGORIES) expect(isPrivilegedPayloadValid(category, {})).toBe(false);
  });
});

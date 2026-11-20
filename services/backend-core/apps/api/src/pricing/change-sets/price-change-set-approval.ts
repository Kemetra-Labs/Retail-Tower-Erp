/**
 * RT-1484 (RT-282 PR-10b) — the approval rules of `submit`, `approve` and `publish` (spec 042 §3,
 * §5, §7; contract `AcknowledgedFindings`, `SubmitUnprocessable`, `WriteForbidden`). Pure.
 *
 *   - Acknowledgements. `submit` lists every `rounded_price` finding the stored preview holds, plus
 *     every `replaces` and `invalidates_dependent` one when the set goes straight to `approved`
 *     (a non-sensitive set); `approve` lists every `replaces` and `invalidates_dependent` one. A
 *     missing kind is `422 acknowledgement_required`; listing a kind the preview lacks is allowed.
 *     A finding is present when any line or preview row carries it, whatever the line's most severe
 *     class (fail closed: an emergency line classed `past_dated` that also supersedes an event
 *     still needs `replaces`).
 *   - Four eyes (Q-B3, A4). A sensitive set — every set in v1, whose approval mode is `always`
 *     (Q-B1) — is approved only by an `owner` / `tenant_admin` who is neither its author nor its
 *     submitter (`403 self_approval_forbidden`). Emergency included: owner and tenant_admin may
 *     start one (RT-1484 comment 17829, decision 3), and an independent second approver is still
 *     required. Publish refuses an approval that breaks this rule, so no path publishes without it.
 *   - Approval mode and lead time are hard-coded v1 defaults (spec 042 §7, RT-1484 comment 17829):
 *     no settings table.
 */

export type AcknowledgeableFinding = "replaces" | "invalidates_dependent" | "rounded_price";

/** Which acknowledgeable findings the stored preview holds. */
export type FindingPresence = Readonly<Record<AcknowledgeableFinding, boolean>>;

/** The findings a transition must acknowledge, in contract order. */
export function requiredAcknowledgements(
  transition: { readonly kind: "submit"; readonly straightToApproved: boolean } | { readonly kind: "approve" },
  present: FindingPresence,
): AcknowledgeableFinding[] {
  const approves = transition.kind === "approve" || transition.straightToApproved;
  const needed: AcknowledgeableFinding[] = [];
  if (approves && present.replaces) needed.push("replaces");
  if (approves && present.invalidates_dependent) needed.push("invalidates_dependent");
  if (transition.kind === "submit" && present.rounded_price) needed.push("rounded_price");
  return needed;
}

/** The required findings `given` does not list (empty: every one is acknowledged). */
export function missingAcknowledgements(required: readonly AcknowledgeableFinding[], given: readonly string[] | undefined): AcknowledgeableFinding[] {
  const listed = new Set(given ?? []);
  return required.filter((f) => !listed.has(f));
}

/** Four eyes: whether `approver` may not approve (or have approved) this sensitive set. */
export function isSelfApproval(set: {
  readonly sensitive: boolean | null;
  readonly createdBy: string;
  readonly submittedBy: string | null;
}, approver: string): boolean {
  // A set whose sensitivity is unknown is treated as sensitive (fail closed).
  if (set.sensitive === false) return false;
  return approver === set.createdBy || approver === set.submittedBy;
}

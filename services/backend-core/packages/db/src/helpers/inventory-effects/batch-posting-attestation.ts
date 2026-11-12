/**
 * The owner attestation of the ERP batch posting (Jira RT-452; RT-50 Q13
 * precondition `erp_batch_posting_verified`; owner decision 2026-11-12).
 *
 * The evidence that the ERPNext-Connector posts batch-tracked lines with their
 * batch reference is a bench run this server cannot read, so the owner attests
 * it, once, with a reference to that evidence. `attestBatchPosting` (operator
 * CLI `inventory-effects attest-batch-posting`), on the caller's tenant-context
 * client:
 *
 *   - upserts the tenant's `tenant_inventory_settings` row if it is missing and
 *     records the attestation time, the operator and the evidence reference in
 *     one statement; every other column of an existing row is left as it is;
 *   - refuses (`already_attested`, nothing written) when the tenant already
 *     holds an attestation: it never silently replaces the recorded evidence;
 *   - switches nothing on. Tracked selling stays a separate owner act (Q13).
 *
 * `activate` writes no audit event either: the settings row is the record
 * (who, when, which evidence). There is no un-attest command: removing the
 * attestation would need an audit of its own, which is a separate decision.
 */
import type { PoolClient } from "pg";

/** The longest evidence reference the settings CHECK admits. */
const EVIDENCE_REF_MAX_LENGTH = 200;

interface AttestBatchPostingInput {
  readonly tenantId: string;
  readonly actorId: string;
  /** A reference to the evidence (a Jira comment, a bench run id); no PII. */
  readonly evidenceRef: string;
}

type BatchPostingAttestationOutcome =
  | { readonly kind: "attested"; readonly attestedAt: string; readonly evidenceRef: string }
  | {
      readonly kind: "refused";
      readonly refusal: { readonly code: "already_attested"; readonly attestedAt: string };
    };

/** The trimmed evidence reference, or throws when it is blank or over the limit. */
export function normalizeEvidenceRef(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > EVIDENCE_REF_MAX_LENGTH) {
    throw new Error(`evidence reference must be 1 to ${EVIDENCE_REF_MAX_LENGTH} characters`);
  }
  return trimmed;
}

export async function attestBatchPosting(
  client: Pick<PoolClient, "query">,
  input: AttestBatchPostingInput,
): Promise<BatchPostingAttestationOutcome> {
  const evidenceRef = normalizeEvidenceRef(input.evidenceRef);
  // One statement: the conflict update applies only while no attestation exists, so two
  // concurrent operators cannot both record one.
  const written = await client.query<{ attested_at: Date }>(
    `INSERT INTO tenant_inventory_settings
       (tenant_id, updated_by, erp_batch_posting_attested_at, erp_batch_posting_attested_by, erp_batch_posting_evidence_ref)
     VALUES ($1, $2, now(), $2, $3)
     ON CONFLICT (tenant_id) DO UPDATE
       SET erp_batch_posting_attested_at = EXCLUDED.erp_batch_posting_attested_at,
           erp_batch_posting_attested_by = EXCLUDED.erp_batch_posting_attested_by,
           erp_batch_posting_evidence_ref = EXCLUDED.erp_batch_posting_evidence_ref,
           updated_by = EXCLUDED.updated_by
       WHERE tenant_inventory_settings.erp_batch_posting_attested_at IS NULL
     RETURNING erp_batch_posting_attested_at AS attested_at`,
    [input.tenantId, input.actorId, evidenceRef],
  );
  const row = written.rows[0];
  if (row !== undefined) return { kind: "attested", attestedAt: row.attested_at.toISOString(), evidenceRef };
  const existing = await client.query<{ attested_at: Date }>(
    `SELECT erp_batch_posting_attested_at AS attested_at FROM tenant_inventory_settings WHERE tenant_id = $1`,
    [input.tenantId],
  );
  return {
    kind: "refused",
    refusal: { code: "already_attested", attestedAt: existing.rows[0]!.attested_at.toISOString() },
  };
}

/**
 * RT-1601 redistribution proposals data layer: typed wrappers over the generated `apiClient` for the
 * six Console operations of `inventory/redistribution-proposals.yaml` (RT-1599 contract, RT-1600
 * runtime). Consume-only: the rule, the validator, the freshness gate and the accept re-check are all
 * Backend-Core's; the Console only sends commands and shows what it answers.
 *
 *   reads    listRedistributionProposals, getRedistributionProposal
 *   writes   createRedistributionProposal (compute), reviewRedistributionProposal,
 *            acceptRedistributionProposal, rejectRedistributionProposal
 *
 * Every write takes an Idempotency-Key and is replayable under it. Same
 * `{ status, data?, error?, retryAfter? }` shape as the rest of `src/lib` (`resultOf`).
 */
import { apiClient } from "@/generated/client";
import type { RedistributionProposalsSchema } from "@/generated/schema";
import { resultOf } from "@/lib/api-result";

type Schemas = RedistributionProposalsSchema.components["schemas"];

export type RedistributionProposal = Schemas["RedistributionProposal"];
export type RedistributionProposalSummary = Schemas["RedistributionProposalSummary"];
export type RedistributionProposalList = Schemas["RedistributionProposalList"];
export type RedistributionProposalLine = Schemas["RedistributionProposalLine"];
export type RedistributionProposalStore = Schemas["RedistributionProposalStore"];
export type RedistributionProposalState = Schemas["RedistributionProposalState"];
export type RedistributionWarning = Schemas["RedistributionWarning"];
export type RedistributionAcceptOutcome = Schemas["RedistributionAcceptOutcome"];
export type RedistributionAcceptResult = Schemas["RedistributionAcceptResult"];
export type RedistributionNothingToMove = Schemas["RedistributionNothingToMove"];
export type RedistributionReviewDecisionValue = Schemas["RedistributionReviewDecisionValue"];
export type RedistributionLineDecision =
  Schemas["ReviewRedistributionProposalCommand"]["lineDecisions"][number];

const BASE = "/api/inventory/v1/redistribution-proposals" as const;
const ONE = "/api/inventory/v1/redistribution-proposals/{proposalId}" as const;

export interface RedistributionListQuery {
  state?: RedistributionProposalState;
  cursor?: string;
  limit?: number;
}

/** GET: the tenant's proposals, newest first, as summaries without lines. */
export async function listRedistributionProposals(query: RedistributionListQuery = {}) {
  return resultOf(await apiClient.GET(BASE, { params: { query } }));
}

/** GET: one proposal with its stores, objective, warnings and lines. */
export async function getRedistributionProposal(proposalId: string) {
  return resultOf(await apiClient.GET(ONE, { params: { path: { proposalId } } }));
}

/** POST: compute. 201 a stored proposal; 200 `nothing_to_move` (nothing stored). */
export async function createRedistributionProposal(
  body: { storeIds?: string[] },
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST(BASE, {
      params: { header: { "Idempotency-Key": idempotencyKey } },
      body,
    }),
  );
}

/** POST review: "would accept" / "would reject" per line; creates nothing. */
export async function reviewRedistributionProposal(
  proposalId: string,
  lineDecisions: RedistributionLineDecision[],
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST(`${ONE}/review`, {
      params: { path: { proposalId }, header: { "Idempotency-Key": idempotencyKey } },
      body: { lineDecisions },
    }),
  );
}

/** POST accept: chosen lines become W3 shipment transfers in `draft` (live phase only). */
export async function acceptRedistributionProposal(
  proposalId: string,
  lineIds: string[],
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST(`${ONE}/accept`, {
      params: { path: { proposalId }, header: { "Idempotency-Key": idempotencyKey } },
      body: { lineIds },
    }),
  );
}

/** POST reject: the proposal becomes `rejected`; accepted lines keep their drafts. */
export async function rejectRedistributionProposal(
  proposalId: string,
  reason: string,
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST(`${ONE}/reject`, {
      params: { path: { proposalId }, header: { "Idempotency-Key": idempotencyKey } },
      body: { reason },
    }),
  );
}

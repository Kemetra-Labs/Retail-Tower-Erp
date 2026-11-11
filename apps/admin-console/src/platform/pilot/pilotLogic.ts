/**
 * RT-1329: pure rules for the Platform Console "POS pilot" page.
 *
 * A release is `current` when it was activated and not withdrawn; a withdrawn
 * release stays withdrawn even if it was activated before (the contract's
 * `release_withdrawn`). Activate is offered on an approved release that is
 * neither withdrawn nor current. It is offered even while another release is
 * current: the server then answers 409 `release_current_exists`, which the page
 * explains (only the promotion workflow can withdraw; no Withdraw control here).
 *
 * The allowlist carries tenant ids only, so names are joined from the platform
 * tenant list the Console already reads; a tenant missing from it keeps its id.
 */
import type { PilotRelease, PilotTenant } from "@/lib/pilot-platform-types";

/** What the page reads of a `listTenants` row (`TenantSummary`: every key optional). */
export interface DirectoryTenant {
  id?: string;
  slug?: string;
  name?: string;
}

type ReleaseState = "registered" | "current" | "withdrawn";

type ReleaseFacts = Pick<PilotRelease, "approved" | "activatedAt" | "withdrawnAt">;

export function releaseState(release: Pick<ReleaseFacts, "activatedAt" | "withdrawnAt">) {
  if (release.withdrawnAt != null) return "withdrawn" satisfies ReleaseState;
  if (release.activatedAt != null) return "current" satisfies ReleaseState;
  return "registered" satisfies ReleaseState;
}

export function canActivate(release: ReleaseFacts): boolean {
  return release.approved && releaseState(release) === "registered";
}

/** The first 12 hex characters; the full digest stays in the cell's title. */
export function shortSha(sha256: string): string {
  return sha256.slice(0, 12);
}

const EVIDENCE_ORIGIN = "https://github.com";
const EVIDENCE_REPO = "/Kemetra-Labs/Retail-Tower-Erp/";

/** An evidence URL as a link only when it is an https GitHub URL (the contract's patterns). */
export function evidenceHref(value: string): string | undefined {
  try {
    const url = new URL(value);
    const ours = url.origin === EVIDENCE_ORIGIN && url.pathname.startsWith(EVIDENCE_REPO);
    return ours ? url.href : undefined;
  } catch {
    return undefined;
  }
}

export interface AllowlistRow {
  tenantId: string;
  name: string | undefined;
  slug: string | undefined;
  addedAt: string;
}

export function allowlistRows(
  pilot: readonly PilotTenant[],
  directory: readonly DirectoryTenant[],
): AllowlistRow[] {
  const byId = new Map(directory.map((t) => [t.id, t]));
  return pilot.map((p) => {
    const tenant = byId.get(p.tenantId);
    return { tenantId: p.tenantId, name: tenant?.name, slug: tenant?.slug, addedAt: p.addedAt };
  });
}

/** Directory tenants not yet on the allowlist, sorted by name, for the Add picker. */
export function addableTenants<T extends DirectoryTenant>(
  directory: readonly T[],
  pilot: readonly PilotTenant[],
): (T & { id: string })[] {
  const listed = new Set(pilot.map((p) => p.tenantId));
  return directory
    .filter((t): t is T & { id: string } => typeof t.id === "string" && !listed.has(t.id))
    .sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
}

// --- Write outcomes ----------------------------------------------------------

interface WriteResult {
  status: number;
  error?: unknown;
}

type Common = "notPermitted" | "rateLimited" | "failed";
export type ActivateKind = "activated" | "currentExists" | "withdrawn" | "notFound" | Common;
export type AddKind = "added" | "alreadyListed" | "tenantNotFound" | Common;
export type RemoveKind = "removed" | Common;

export interface Outcome<K extends string> {
  kind: K;
  requestId?: string;
}

function errorOf(result: WriteResult): { code?: string; request_id?: string } {
  return (
    (result.error as { error?: { code?: string; request_id?: string } } | undefined)?.error ?? {}
  );
}

/** 403 `forbidden` / `origin_rejected`, 429 and anything else unexpected. */
function common(result: WriteResult): Outcome<Common> {
  if (result.status === 403) return { kind: "notPermitted" };
  if (result.status === 429) return { kind: "rateLimited" };
  return { kind: "failed", requestId: errorOf(result).request_id };
}

export function activateOutcome(result: WriteResult): Outcome<ActivateKind> {
  const { code } = errorOf(result);
  if (result.status === 200) return { kind: "activated" };
  if (result.status === 409 && code === "release_current_exists") return { kind: "currentExists" };
  if (result.status === 409 && code === "release_withdrawn") return { kind: "withdrawn" };
  if (result.status === 404) return { kind: "notFound" };
  return common(result);
}

export function addOutcome(result: WriteResult): Outcome<AddKind> {
  if (result.status === 201) return { kind: "added" };
  if (result.status === 200) return { kind: "alreadyListed" };
  if (result.status === 404) return { kind: "tenantNotFound" };
  return common(result);
}

export function removeOutcome(result: WriteResult): Outcome<RemoveKind> {
  if (result.status === 204) return { kind: "removed" };
  return common(result);
}

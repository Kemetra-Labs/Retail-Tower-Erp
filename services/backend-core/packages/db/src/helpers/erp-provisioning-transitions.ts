/**
 * RT-1389 — THE status-transition table of `erp_provisioning_request`, shared by
 * every writer: the api repository (`writeRequest`) and the worker sweep
 * (`sweepErpProvisioning`). It lives here, in `packages/db`, because the sweep
 * cannot import the api package; `apps/api/src/erp-provisioning/provisioning-state.ts`
 * re-exports it. Do not copy it anywhere else.
 *
 * Migration 0112 encodes the same table in SQL (`erp_provisioning_transition_allowed`),
 * so a raw UPDATE cannot bypass it either; the 0112 spec checks that both agree on
 * every (from, to) pair.
 */
import type { ErpProvisioningStatus } from "../schema/erp-provisioning";

export type { ErpProvisioningStatus };

/** The status transitions any writer may perform (the exhaustive test pins this table). */
export const ERP_PROVISIONING_ALLOWED_TRANSITIONS: Readonly<Record<ErpProvisioningStatus, readonly ErpProvisioningStatus[]>> = {
  requested: ["claimed", "cancelled"],
  claimed: ["site_created", "erp_configured", "connector_installed", "credential_bound", "verifying", "failed_retryable", "failed_permanent", "cancelled"],
  site_created: ["erp_configured", "connector_installed", "credential_bound", "verifying", "failed_retryable", "failed_permanent", "cancelled"],
  erp_configured: ["connector_installed", "credential_bound", "verifying", "failed_retryable", "failed_permanent", "cancelled"],
  connector_installed: ["credential_bound", "verifying", "failed_retryable", "failed_permanent", "cancelled"],
  credential_bound: ["verifying", "failed_retryable", "failed_permanent", "cancelled"],
  verifying: ["succeeded", "failed_retryable", "failed_permanent", "cancelled"],
  succeeded: [],
  failed_retryable: ["claimed", "failed_permanent", "cancelled"],
  failed_permanent: [],
  compensating: [],
  compensated: [],
  cancelled: [],
};

/** A status may stay the same (lease and counter writes), or move along the table. */
export function erpProvisioningTransitionAllowed(from: ErpProvisioningStatus, to: ErpProvisioningStatus): boolean {
  return from === to || ERP_PROVISIONING_ALLOWED_TRANSITIONS[from].includes(to);
}

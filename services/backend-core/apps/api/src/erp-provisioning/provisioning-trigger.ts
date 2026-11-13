/**
 * RT-1358 — the unlock trigger of RT-1353, adapted: in the SAME transaction as the
 * unlock request it creates the managed connector registration and the
 * `erp_provisioning_request`, through this internal system path (no human cookie
 * route, no secret: the credential is issued later, lease-bound).
 *
 * Runs in the platform-admin context of the unlock transaction, inside the target
 * tenant's context (the registration's RLS policies need it). The deployment
 * environment comes from `DEPLOYMENT_ENVIRONMENT`; the site reference is the
 * derived site name. A second unlock never reaches this (the entitlement already
 * says `already_requested`) and the one-active-`tenant.provision` unique index is
 * the backstop: an existing active request is returned instead of a second.
 */
import { ServiceUnavailableException } from "@nestjs/common";
import { newId } from "@data-pulse-2/shared";
import type { PoolClient } from "pg";

import { resolveDeploymentEnvironment } from "../connector/deployment-environment";
import { AUDIT, insertProvisioningAudit } from "./provisioning-audit";
import { deriveSiteName, SYSTEM_ACTOR_USER_ID, TEMPLATE_ID, TEMPLATE_VERSION } from "./provisioning.config";
import { insertRequest, readActiveTenantRequest, type RequestRow } from "./provisioning-request.repository";

/** Fail closed, before any write, when this deployment does not declare its environment. */
export function requireDeploymentEnvironment(): string {
  const environment = resolveDeploymentEnvironment();
  if (environment === null) {
    throw new ServiceUnavailableException({ code: "service_unavailable", message: "Provisioning is not available on this deployment." });
  }
  return environment;
}

export async function createProvisioningForUnlock(
  client: PoolClient,
  input: { readonly tenantId: string; readonly actorUserId: string; readonly httpRequestId: string | null },
): Promise<RequestRow> {
  const environment = requireDeploymentEnvironment();
  const existing = await readActiveTenantRequest(client, input.tenantId);
  if (existing !== null) return existing;

  const siteName = deriveSiteName(input.tenantId, environment);
  const registrationId = newId();
  await client.query(
    `INSERT INTO connector_registration
       (id, tenant_id, display_name, erpnext_site_ref, environment, created_by, managed_by)
     VALUES ($1, $2, 'ERP site (managed)', $3, $4, $5, 'provisioner')`,
    [registrationId, input.tenantId, siteName, environment, SYSTEM_ACTOR_USER_ID],
  );
  const request = await insertRequest(client, {
    tenantId: input.tenantId,
    siteName,
    templateId: TEMPLATE_ID,
    templateVersion: TEMPLATE_VERSION,
    connectorRegistrationId: registrationId,
  });
  await insertProvisioningAudit(client, {
    actorUserId: input.actorUserId,
    tenantId: input.tenantId,
    action: AUDIT.requested,
    targetType: "erp_provisioning_request",
    targetId: request.id,
    requestId: input.httpRequestId,
    metadata: { kind: "tenant.provision", connector_registration_id: registrationId },
  });
  return request;
}

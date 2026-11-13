/**
 * RT-1357 (0109): ERP provisioning storage (RT-1352 PB-B). The request table,
 * its append-only step log and the provisioner credential store. The RLS
 * policies decide who may do what (a platform admin creates requests, the
 * provisioner machine bearer, through `app.is_provisioner`, moves them and
 * appends the log, only a platform admin touches the credential store); the
 * grants only open the door. Never DELETE or TRUNCATE (no row is ever removed,
 * and TRUNCATE is not subject to row security); the step log gets no UPDATE
 * (append-only). The auth lookup role has BYPASSRLS, so any grant would expose
 * every tenant's provisioning state.
 */
import { ALL_TABLE_PRIVILEGES, type GrantFragment } from "../grant-fragment";

export const GRANTS: GrantFragment = {
  deployScripts: ["erp-provisioning-domain-grants.sql"],
  domainRequired: [
    ["erp_provisioning_request", "SELECT"],
    ["erp_provisioning_request", "INSERT"],
    ["erp_provisioning_request", "UPDATE"],
    ["erp_provisioning_step_log", "SELECT"],
    ["erp_provisioning_step_log", "INSERT"],
    ["erp_provisioner_credential", "SELECT"],
    ["erp_provisioner_credential", "INSERT"],
    ["erp_provisioner_credential", "UPDATE"],
  ],
  lookupForbidden: [
    ["erp_provisioning_request", ALL_TABLE_PRIVILEGES],
    ["erp_provisioning_step_log", ALL_TABLE_PRIVILEGES],
    ["erp_provisioner_credential", ALL_TABLE_PRIVILEGES],
  ],
  lookupAllowed: [],
};

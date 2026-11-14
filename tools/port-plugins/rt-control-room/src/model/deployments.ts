import type { Deployment } from "./types";

/**
 * Port's `deployment` blueprint mixes real lab deploys with merge proxies. Live (2026-11-14):
 * `evidenceType` is `lab_job` (6, Staging), `merge_proxy` (423, Unknown) or `verified_deployment`.
 * Only real deploys count, so a merged PR is never shown as a deploy.
 */
const REAL_EVIDENCE = new Set(["lab_job", "verified_deployment"]);

export function isRealDeployment(d: Deployment): boolean {
  const ev = d.properties?.evidenceType;
  return typeof ev === "string" && REAL_EVIDENCE.has(ev);
}

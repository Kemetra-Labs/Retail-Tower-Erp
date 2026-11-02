/**
 * The roles that read the 017 posting backlog and repair a posting
 * dead-letter (`listPostingBacklog`, `repairPosting`).
 *
 * RT-1061 (RT-977 §4, §5, D3): `console-sales` `consoleGetSale` shows a
 * failed posting's stored rejection `reason` (RT-410, PII-suspect) and its
 * `repairPosting` handle only to a session these routes admit: these roles,
 * through the same tenant role gate (`auth/tenant-role-gate.ts`), including
 * its platform-admin session bypass. One constant, so the readers of the
 * reason and the callers of the repair cannot drift apart.
 */
import type { RoleCode } from "../../auth/roles.decorator";

export const POSTING_BACKLOG_ROLES = ["owner", "tenant_admin"] as const satisfies readonly RoleCode[];

/**
 * Which routes record a platform admin's request in a tenant
 * (`x-support-session-enforcement` in platform-support-sessions.openapi.yaml):
 *
 *   - every route mounted behind `TenantContextGuard` — the session's ACTIVE
 *     tenant;
 *   - `switchActiveStore` — the active tenant;
 *   - the path-tenant routes `listMembers` and `updateTenant` — the
 *     `{tenant_id}` path segment (owner decision 6, 2026-10-12).
 *
 * Since RT-1468 a covered route admits every platform admin (member or not, no
 * support session needed, suspended tenant included) and records one
 * `platform.cross_tenant.accessed` row per request (`SupportSessionGate.admit`).
 *
 * Guards are matched by class NAME, not by reference: `AuthGuard` must not
 * import `TenantContextGuard` (that would close an import cycle through
 * `auth.module`).
 */
import type { ExecutionContext } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";

export type CoveredTarget =
  | { readonly kind: "active-tenant" }
  | { readonly kind: "path-tenant"; readonly param: string };

const TENANT_CONTEXT_GUARD = "TenantContextGuard";

const ACTIVE_TENANT_HANDLERS: ReadonlyMap<string, CoveredTarget> = new Map([
  ["ContextController.switchStore", { kind: "active-tenant" }],
]);

export const PATH_TENANT_HANDLERS: ReadonlyMap<string, CoveredTarget> = new Map([
  ["TenantsController.listMembers", { kind: "path-tenant", param: "id" }],
  ["TenantsController.update", { kind: "path-tenant", param: "id" }],
]);

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type -- Nest controller classes and handlers
type Fn = Function;

export function handlerKey(execCtx: ExecutionContext): string {
  return `${(execCtx.getClass() as Fn).name}.${(execCtx.getHandler() as Fn).name}`;
}

/** The covered target of the route, or null when it is not covered. */
export function coveredTarget(execCtx: ExecutionContext): CoveredTarget | null {
  const key = handlerKey(execCtx);
  const named = PATH_TENANT_HANDLERS.get(key) ?? ACTIVE_TENANT_HANDLERS.get(key);
  if (named) return named;
  const guards = [
    ...((Reflect.getMetadata(GUARDS_METADATA, execCtx.getClass()) as unknown[] | undefined) ?? []),
    ...((Reflect.getMetadata(GUARDS_METADATA, execCtx.getHandler()) as unknown[] | undefined) ?? []),
  ];
  const tenantGuarded = guards.some(
    (guard) => typeof guard === "function" && (guard as Fn).name === TENANT_CONTEXT_GUARD,
  );
  return tenantGuarded ? { kind: "active-tenant" } : null;
}

/**
 * Extract the route template from an ExecutionContext using NestJS
 * decorator metadata. Returns the controller + handler path in the form
 * `/api/v1/tenants/:id/members`, or `"unknown"` when metadata is absent
 * (e.g., in unit tests with stub controllers).
 *
 * Uses `route` template (not rendered URL) per signals.md §6: rendered
 * paths carry tenant/store IDs which are forbidden as metric labels
 * (FR-B-006). The template `/:id` is safe; the value `/:uuid` is not.
 */
export function routeTemplate(execCtx: ExecutionContext): string {
  try {
    // `reflect-metadata` is loaded by NestJS at bootstrap; Reflect.getMetadata
    // is available in all NestJS guard/interceptor call sites.
    const controllerPath =
      (Reflect.getMetadata("path", execCtx.getClass()) as string | undefined) ?? "";
    const handlerPath =
      (Reflect.getMetadata("path", execCtx.getHandler()) as string | undefined) ?? "";
    const joined = `/${controllerPath}/${handlerPath}`.replace(/\/+/g, "/");
    // Trim trailing slash so "/api/v1/tenants/" becomes "/api/v1/tenants".
    return joined.replace(/\/$/, "") || "unknown";
  } catch {
    return "unknown";
  }
}

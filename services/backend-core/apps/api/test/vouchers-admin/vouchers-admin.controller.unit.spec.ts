/**
 * RT-1108 — the wiring of `VouchersAdminController` that the HTTP spec cannot
 * prove (it stubs cookie authentication): the guard order (the session-only
 * and RT-430 Origin checks live in `SessionOnlyAdminGuard`), the owner / tenant_admin
 * roles with a 403 refusal, and the idempotency policy of each POST.
 * Docker-free.
 */
import "reflect-metadata";

import { GUARDS_METADATA, HEADERS_METADATA, HTTP_CODE_METADATA } from "@nestjs/common/constants";

import { AUDITABLE_KEY } from "../../src/audit/auditable.decorator";
import { ROLES_METADATA_KEY } from "../../src/auth/roles.decorator";
import { RolesGuard } from "../../src/auth/roles.guard";
import { SessionOnlyAdminGuard } from "../../src/auth/session-only-admin.guard";
import { TenantContextGuard } from "../../src/context/tenant-context.guard";
import { IDEMPOTENT_OPTIONS_KEY, IDEMPOTENT_POLICY_KEY } from "../../src/idempotency/idempotent.decorator";
import { VouchersAdminController } from "../../src/vouchers-admin/vouchers-admin.controller";

const proto = VouchersAdminController.prototype as unknown as Record<string, object>;
const meta = (key: string, handler: string): unknown => Reflect.getMetadata(key, proto[handler]!);

describe("VouchersAdminController wiring", () => {
  it("uses the cookie-session-only guards: SessionOnlyAdminGuard (bearer 401, RT-430 Origin), TenantContextGuard, RolesGuard", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, VouchersAdminController)).toEqual([
      SessionOnlyAdminGuard,
      TenantContextGuard,
      RolesGuard,
    ]);
  });

  it.each(["issue", "list", "get", "cancel"])("%s is owner / tenant_admin only and answers 403 for another role", (handler) => {
    expect(meta(ROLES_METADATA_KEY, handler)).toMatchObject({ any: ["owner", "tenant_admin"], denyAs: 403 });
  });

  it("issue is non-replayable with only batch_id kept, 201 and no-store", () => {
    expect(meta(IDEMPOTENT_POLICY_KEY, "issue")).toBe("required");
    expect(meta(IDEMPOTENT_OPTIONS_KEY, "issue")).toEqual({ replay: "forbid", replayMarkerFields: ["batch_id"] });
    expect(meta(HTTP_CODE_METADATA, "issue")).toBe(201);
    expect(meta(HEADERS_METADATA, "issue")).toEqual([{ name: "Cache-Control", value: "no-store" }]);
  });

  it("cancel is replayable and answers 200", () => {
    expect(meta(IDEMPOTENT_POLICY_KEY, "cancel")).toBe("required");
    expect(meta(IDEMPOTENT_OPTIONS_KEY, "cancel")).toEqual({});
    expect(meta(HTTP_CODE_METADATA, "cancel")).toBe(200);
  });

  it("the reads carry the contract's audit codes and no idempotency policy", () => {
    expect(meta(AUDITABLE_KEY, "list")).toBe("vouchers.listed");
    expect(meta(AUDITABLE_KEY, "get")).toBe("vouchers.read");
    expect(meta(IDEMPOTENT_POLICY_KEY, "list")).toBeUndefined();
    expect(meta(IDEMPOTENT_POLICY_KEY, "get")).toBeUndefined();
    // The writes audit on their own transaction, never through the async interceptor.
    expect(meta(AUDITABLE_KEY, "issue")).toBeUndefined();
    expect(meta(AUDITABLE_KEY, "cancel")).toBeUndefined();
  });
});

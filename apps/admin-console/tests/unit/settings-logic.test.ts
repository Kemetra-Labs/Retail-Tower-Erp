import { canOpenSettings } from "@/settings/settingsLogic";
import { describe, expect, test } from "vitest";

/** RF-7 (spec 016): only the tenant's admins may open Settings. */
describe("canOpenSettings", () => {
  test("owner and tenant_admin may open Settings", () => {
    expect(canOpenSettings("owner")).toBe(true);
    expect(canOpenSettings("tenant_admin")).toBe(true);
  });

  test("other roles, and no role, may not", () => {
    for (const role of [
      "store_manager",
      "store_staff",
      "cashier",
      "auditor",
      "platform_admin",
      "",
      null,
      undefined,
    ]) {
      expect(canOpenSettings(role)).toBe(false);
    }
  });
});

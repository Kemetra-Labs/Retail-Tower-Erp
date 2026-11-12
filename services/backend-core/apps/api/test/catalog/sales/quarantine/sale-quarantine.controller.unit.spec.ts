/**
 * RT-1312 Phase 3(b): the `posQuarantineSale` route wiring. The HTTP
 * integration spec stubs the rate-limit guard, so this spec pins what it
 * cannot see: the device guard runs first, then the per-device rate limit on
 * the upload's own bucket (decision P6), never capture's `posWriteSale`.
 */
import "reflect-metadata";

import { GUARDS_METADATA, HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";

import { AUDITABLE_KEY } from "../../../../src/audit/auditable.decorator";
import { PosDeviceAuthGuard } from "../../../../src/auth/pos-device-auth.guard";
import { POS_WRITE_RATE_LIMIT_BUCKET_KEY } from "../../../../src/auth/pos-write-rate-limit.decorator";
import { PosWriteRateLimitGuard } from "../../../../src/auth/pos-write-rate-limit.guard";
import { POS_WRITE_RATE_LIMIT_BUCKETS } from "../../../../src/auth/rate-limit";
import { DEVICE_BEARER_KEY } from "../../../../src/auth/route-auth";
import { SaleQuarantineController } from "../../../../src/catalog/sales/quarantine/sale-quarantine.controller";

const handler = Object.getOwnPropertyDescriptor(SaleQuarantineController.prototype, "upload")?.value as object;

describe("RT-1312 SaleQuarantineController wiring", () => {
  it("serves POST api/pos/v1/quarantined-sales on the device bearer", () => {
    expect(Reflect.getMetadata(PATH_METADATA, SaleQuarantineController)).toBe("api/pos/v1/quarantined-sales");
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(1); // RequestMethod.POST
    expect(Reflect.getMetadata(DEVICE_BEARER_KEY, SaleQuarantineController)).toBe(true);
  });

  it("runs the device guard, then the per-device rate limit on its own bucket (P6)", () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, handler)).toEqual([PosDeviceAuthGuard, PosWriteRateLimitGuard]);
    expect(Reflect.getMetadata(POS_WRITE_RATE_LIMIT_BUCKET_KEY, handler)).toBe("posWriteSaleQuarantine");
    expect(POS_WRITE_RATE_LIMIT_BUCKETS.posWriteSaleQuarantine).toEqual({ limit: 120, windowMs: 60 * 60 * 1000 });
  });

  it("is no-store and audited", () => {
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([{ name: "Cache-Control", value: "no-store" }]);
    expect(Reflect.getMetadata(AUDITABLE_KEY, handler)).toBe("pos_sales.quarantine_uploaded");
  });
});

/**
 * Harness for the voucher issuance HTTP integration spec (RT-1108): the payer
 * harness's Console members and sessions, an Ajv checker over
 * `vouchers-admin.openapi.yaml`, and a RECORDING idempotency store, so a spec
 * can prove that no voucher code reaches idempotency storage (Redis values or
 * the Postgres mirror writes).
 *
 * `.ts` (not `.spec.ts`) so Jest does not collect it.
 */
import "reflect-metadata";

import { resolve } from "node:path";

import { APP_INTERCEPTOR, Reflector } from "@nestjs/core";
import Ajv from "ajv";
import addFormats from "ajv-formats";

import { IdempotencyKeyStore } from "@data-pulse-2/shared";

import { IDEMPOTENCY_KEY_STORE, IdempotencyInterceptor } from "../../../src/idempotency/idempotency.interceptor";
import { InProgressMarker } from "../../../src/idempotency/in-progress-marker";
import { loadOpenApiContracts } from "../../../src/openapi/loader";

export {
  SES_ADMIN_X,
  SES_MANAGER,
  SES_OWNER_ACTIVE_X,
  SES_OWNER_ALL,
  SES_OWNER_B,
  SES_STAFF,
  seedPayerMembers,
} from "../../settlement/__support__/payer-http-harness";

/** Everything the idempotency layer persisted, as text, for "no code in storage" assertions. */
export interface IdempotencyRecorder {
  /** Every Redis value ever written, serialised. */
  readonly redisValues: string[];
  /** Every Postgres mirror insert, serialised. */
  readonly mirrorWrites: string[];
}

class RecordingRedis {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  constructor(private readonly recorder: IdempotencyRecorder) {}
  async get(key: string): Promise<string | null> {
    const e = this.entries.get(key);
    if (!e || Date.now() > e.expiresAt) return null;
    return e.value;
  }
  async set(key: string, value: string, options: { px: number }): Promise<unknown> {
    this.recorder.redisValues.push(value);
    this.entries.set(key, { value, expiresAt: Date.now() + options.px });
    return "OK";
  }
}

class FakeMarker {
  async trySet(): Promise<boolean> {
    return true;
  }
  async del(): Promise<void> {
    /* no-op */
  }
}

/** The real `IdempotencyInterceptor` over a recording fake Redis. */
export function recordingIdempotencyProviders(): { providers: ReturnType<typeof buildProviders>; recorder: IdempotencyRecorder } {
  const recorder: IdempotencyRecorder = { redisValues: [], mirrorWrites: [] };
  return { providers: buildProviders(recorder), recorder };
}

function buildProviders(recorder: IdempotencyRecorder) {
  const store = new IdempotencyKeyStore({
    redis: new RecordingRedis(recorder),
    pgWriter: {
      async insert(...args: unknown[]) {
        recorder.mirrorWrites.push(JSON.stringify(args));
      },
    },
    pgReader: {
      async find() {
        return null;
      },
    },
    defaultTtlMs: 72 * 60 * 60 * 1000,
  });
  const interceptor = new IdempotencyInterceptor(new Reflector(), store, new FakeMarker() as unknown as InProgressMarker);
  return [
    { provide: IDEMPOTENCY_KEY_STORE, useValue: store },
    { provide: APP_INTERCEPTOR, useValue: interceptor },
  ];
}

/** An Ajv checker over `vouchers-admin.openapi.yaml`: `check("Voucher", body)` throws on a contract violation. */
export function voucherContractChecker(): (name: string, body: unknown) => void {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const dir = resolve(__dirname, "..", "..", "..", "..", "..", "packages", "contracts", "openapi");
  const contract = loadOpenApiContracts({ dir }).find((c) => c.id === "vouchers-admin.openapi");
  if (!contract) throw new Error("vouchers-admin.openapi.yaml not found");
  ajv.addSchema(contract.document as object, "vouchers");
  return (name, body) => {
    const validate = ajv.getSchema(`vouchers#/components/schemas/${name}`);
    if (!validate) throw new Error(`ajv cannot resolve ${name}`);
    if (!validate(body)) throw new Error(`contract violation (${name}): ${JSON.stringify(validate.errors)}`);
  };
}

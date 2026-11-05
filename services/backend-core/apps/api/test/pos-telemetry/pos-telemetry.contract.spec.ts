/**
 * RT-1252: the POS device telemetry contract, `pos-telemetry.openapi.yaml`
 * 1.0.0-draft. `[GATED]` contract, approved on RT-1252 (comment 15673).
 * Structural / load-only: no app boot and no HTTP. What this pins:
 *
 *   1. The config GET and the tunnel POST, on paths without "sentry".
 *   2. Auth: the `device` scheme only, with the generic 401.
 *   3. The envelope body types and the 64 KiB cap.
 *   4. The closed response sets, error bodies on the canonical envelope.
 *   5. The config never carries a DSN; 204 when inert; `no-store`.
 *   6. The refs, capture-terminal, not-an-open-relay and inert rules in prose.
 */
import "reflect-metadata";

import { loadOpenApiContracts } from "../../src/openapi/loader";

const PATH = "/api/pos/v1/telemetry/envelope";
const CONFIG_PATH = "/api/pos/v1/telemetry/config";
const ERROR_REF = "#/components/schemas/Error";

type MediaMap = Record<string, { schema: { $ref?: string } }>;

interface ResponseObject {
  $ref?: string;
  description?: string;
  headers?: Record<string, unknown>;
  content?: MediaMap;
}

interface OperationObject {
  operationId: string;
  security: Array<Record<string, unknown>>;
  requestBody?: { required: boolean; content: MediaMap };
  responses: Record<string, ResponseObject>;
  "x-runtime-status"?: string;
}

interface Contract {
  openapi: string;
  info: { version: string; description: string };
  paths: Record<string, Record<string, OperationObject>>;
  components: {
    securitySchemes: Record<string, { type: string; scheme: string }>;
    schemas: Record<string, Record<string, unknown>>;
  };
}

let doc: Contract;
let op: OperationObject;
let config: OperationObject;

beforeAll(() => {
  const found = loadOpenApiContracts().find((c) => c.id === "pos-telemetry.openapi");
  if (!found) throw new Error("pos-telemetry.openapi not found in packages/contracts/openapi/");
  doc = found.document as Contract;
  op = doc.paths[PATH]!["post"]!;
  config = doc.paths[CONFIG_PATH]!["get"]!;
});

const flat = (text: string): string => text.replace(/\s+/g, " ");

describe("pos-telemetry.openapi — RT-1252 POS device Sentry tunnel", () => {
  it("declares the config GET and the tunnel POST, keeping 'sentry' out of the paths", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.version).toBe("1.0.0-draft");
    expect(Object.keys(doc.paths).sort()).toEqual([CONFIG_PATH, PATH]);
    expect(config.operationId).toBe("posGetTelemetryConfig");
    expect(op.operationId).toBe("posForwardTelemetryEnvelope");
    for (const path of Object.keys(doc.paths)) expect(path).not.toMatch(/sentry/i);
    expect(op["x-runtime-status"]).toBeUndefined();
    expect(config["x-runtime-status"]).toBeUndefined();
  });

  it("uses the device bearer scheme only, with a 401", () => {
    expect(doc.components.securitySchemes["device"]).toMatchObject({ type: "http", scheme: "bearer" });
    for (const operation of [op, config]) {
      expect(operation.security).toEqual([{ device: [] }]);
      expect(operation.responses["401"]).toBeDefined();
    }
  });

  it("takes the envelope media types with the 64 KiB cap", () => {
    expect(op.requestBody?.required).toBe(true);
    expect(Object.keys(op.requestBody!.content).sort()).toEqual([
      "application/octet-stream",
      "application/x-sentry-envelope",
      "text/plain",
    ]);
    expect(doc.components.schemas["Envelope"]).toMatchObject({ type: "string", maxLength: 65536 });
  });

  it("closes the response sets, errors on the canonical envelope", () => {
    expect(Object.keys(op.responses).sort()).toEqual(["204", "400", "401", "413", "415", "429"]);
    for (const status of ["400", "413", "415", "429"]) {
      expect(op.responses[status]!.content!["application/json"]!.schema.$ref).toBe(ERROR_REF);
    }
    expect(op.responses["429"]!.headers).toHaveProperty("Retry-After");
    expect(Object.keys(config.responses).sort()).toEqual(["200", "204", "401"]);
  });

  it("never puts a DSN in the config, answers 204 when inert, no-store", () => {
    const schema = doc.components.schemas["PosTelemetryConfig"] as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { const?: unknown }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required.sort()).toEqual(["enabled", "environment", "tunnel"]);
    expect(Object.keys(schema.properties)).not.toContain("dsn");
    expect(schema.properties["tunnel"]!.const).toBe(PATH);
    expect(config.responses["200"]!.headers).toHaveProperty("Cache-Control");
    expect(config.responses["204"]!.headers).toHaveProperty("Cache-Control");
  });

  it("states the refs, capture-terminal, open-relay and inert rules", () => {
    const text = flat(doc.info.description);
    for (const phrase of [
      "tenant_ref",
      "store_ref",
      "terminal_ref",
      "POS_TELEMETRY_REF_KEY",
      "capture_terminal_id",
      "raw tenant, store and device ids are never forwarded",
      "Not an open relay",
      "POS_SENTRY_DSN",
      "Default-inert",
      "never blocks a sale",
    ]) {
      expect(text).toContain(phrase);
    }
  });
});

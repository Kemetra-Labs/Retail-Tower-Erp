/**
 * RT-1312 Phase 3(a) — the sale quarantine contract, contract-only (owner
 * decision D1, RT-1312 comment 16359; RT-1124 F1/F20, RT-1125 R-02).
 *
 * Two files:
 *   - `pos-sales/sale-quarantine.yaml` 1.0.0-draft: `posQuarantineSale`, the
 *     till's upload of a refused or held sale over the device bearer;
 *   - `sale-sync-ops/sale-sync-ops.yaml` 1.3.0-draft: the Console list, read
 *     and repair of quarantined sales, added beside the unchanged
 *     NEEDS_REPAIR operations.
 *
 * Structural / load-only, plus AJV fixtures. No app boot and no HTTP. What
 * this pins:
 *   1. The four new operations at their paths, each contract-only with a note
 *      and an audit action; no operationId collision.
 *   2. The upload: device bearer only; tenant, store and device never in the
 *      body; natural idempotency (no Idempotency-Key header); 200/201/409
 *      answers; the stored body is an opaque object, NOT a CaptureSaleRequest.
 *   3. The reason: a closed kind enum mirroring the till's dead-letter
 *      reasons plus the held case; status and code nullable; never 401/425/429.
 *   4. The Console side: cookieAuth, the existing roles' shared responses,
 *      repair needs its own Idempotency-Key and answers 409 repair_conflict;
 *      no money and no stored body on the projection.
 *   5. The existing NEEDS_REPAIR operations and schemas are unchanged.
 *   6. The open owner questions are written in both files.
 */
import 'reflect-metadata';

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import {
  allContracts,
  contractDocument,
  operationIdsExcept,
  type ApiPath,
  type OpenApiDocument,
  type OperationObject,
} from '../../_helpers/openapi-contract';

const POS_ID = 'sale-quarantine';
const OPS_ID = 'sale-sync-ops';
const UPLOAD: ApiPath = '/api/pos/v1/quarantined-sales';
const LIST: ApiPath = '/api/v1/catalog/sale-sync-ops/quarantined-sales';
const ONE: ApiPath = '/api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}';
const REPAIR: ApiPath = '/api/v1/catalog/sale-sync-ops/quarantined-sales/{quarantineRef}/repair';

const CONSOLE_OPS: ReadonlyArray<readonly [string, ApiPath, 'get' | 'post', string]> = [
  ['consoleListQuarantinedSales', LIST, 'get', 'sale_sync_ops.quarantine.listed'],
  ['consoleGetQuarantinedSale', ONE, 'get', 'sale_sync_ops.quarantine.read'],
  ['consoleRepairQuarantinedSale', REPAIR, 'post', 'sale_sync_ops.quarantine.repair.requested'],
];

const REF = '0a000000-0000-7000-8000-000000001312';
const STORE = '0a000000-0000-7000-8000-000000000003';
const DEVICE = '0a000000-0000-7000-8000-000000000004';
const AT = '2026-11-11T10:00:00.000Z';

let pos: OpenApiDocument;
let ops: OpenApiDocument;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  pos = contractDocument(contracts, POS_ID);
  ops = contractDocument(contracts, OPS_ID);
  ajv.addSchema(pos as object, POS_ID);
  ajv.addSchema(ops as object, OPS_ID);
});

function validator(id: string, name: string): ValidateFunction {
  const v = ajv.getSchema(`${id}#/components/schemas/${name}`);
  if (!v) throw new Error(`ajv cannot resolve ${id} ${name}`);
  return v;
}

function op(doc: OpenApiDocument, path: ApiPath, method: 'get' | 'post'): OperationObject {
  const found = doc.paths?.[path]?.[method];
  if (!found) throw new Error(`${method.toUpperCase()} ${path} not declared`);
  return found;
}

function schema(doc: OpenApiDocument, name: string): Record<string, unknown> {
  const found = doc.components?.schemas?.[name] as Record<string, unknown> | undefined;
  if (!found) throw new Error(`schema ${name} not declared`);
  return found;
}

const upload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  sourceSystem: 'pos-pulse',
  externalId: 'pos-pulse:0a000000-0000-7000-8000-00000000abcd',
  idempotencyKey: 'pos-pulse:0a000000-0000-7000-8000-00000000abcd',
  reason: { kind: 'refused', httpStatus: 422, errorCode: 'sale_tender_mismatch' },
  tillRecordedAt: AT,
  saleBody: { sourceSystem: 'pos-pulse', lines: 'not validated here' },
  ...over,
});

const item = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  quarantineRef: REF,
  storeId: STORE,
  deviceId: DEVICE,
  sourceSystem: 'pos-pulse',
  externalId: 'pos-pulse:x',
  reasonKind: 'refused',
  tillHttpStatus: 422,
  tillErrorCode: 'sale_tender_mismatch',
  state: 'open',
  receivedAt: AT,
  tillRecordedAt: AT,
  previousTerminalId: null,
  repairCount: 0,
  lastRepair: null,
  saleRef: null,
  ...over,
});

describe('sale quarantine — operations', () => {
  it('the POS file declares only the upload, as 1.0.0-draft', () => {
    expect(pos.info?.version).toBe('1.0.0-draft');
    expect(Object.keys(pos.paths ?? {})).toEqual([UPLOAD]);
    expect(Object.keys(pos.paths![UPLOAD]!)).toEqual(['post']);
  });

  it('sale-sync-ops is 1.3.0-draft and still has no POS route', () => {
    expect(ops.info?.version).toBe('1.3.0-draft');
    expect(Object.keys(ops.paths ?? {}).filter((p) => p.startsWith('/api/pos/'))).toEqual([]);
  });

  it.each([
    ['posQuarantineSale', POS_ID, UPLOAD, 'post', 'sale.quarantine.uploaded'] as const,
    ...CONSOLE_OPS.map(([id, path, method, audit]) => [id, OPS_ID, path, method, audit] as const),
  ])(
    '%s is contract-only, with an RT-1312 note and its audit action',
    (id, docId, path, method, audit) => {
      const o = op(docId === POS_ID ? pos : ops, path, method);
      expect(o.operationId).toBe(id);
      expect(o['x-runtime-status']).toBe('contract-only');
      expect(o['x-runtime-note']).toEqual(expect.stringContaining('RT-1312 Phase 3(b)'));
      expect(o['x-audit-action']).toBe(audit);
    },
  );

  it('collides with no operationId elsewhere', () => {
    const contracts = allContracts();
    expect(operationIdsExcept(contracts, POS_ID).has('posQuarantineSale')).toBe(false);
    const others = operationIdsExcept(contracts, OPS_ID);
    for (const [id] of CONSOLE_OPS) expect(others.has(id)).toBe(false);
  });
});

describe('sale quarantine — the POS upload', () => {
  const post = (): OperationObject => op(pos, UPLOAD, 'post');

  it('accepts the device bearer only', () => {
    expect(post().security).toEqual([{ device: [] }]);
    expect(Object.keys(pos.components?.securitySchemes ?? {})).toEqual(['device']);
  });

  it('is naturally idempotent: no Idempotency-Key header, 200 / 201 / 409', () => {
    expect(post()['x-idempotency' as keyof OperationObject]).toBeUndefined();
    expect(post().parameters).toBeUndefined();
    expect(Object.keys(post().responses ?? {}).sort()).toEqual([
      '200',
      '201',
      '400',
      '401',
      '409',
      '429',
      '500',
    ]);
    expect(post().responses?.['409']).toEqual({
      $ref: '#/components/responses/QuarantineConflict',
    });
    expect(pos.components?.responses?.['QuarantineConflict']?.description).toEqual(
      expect.stringContaining('quarantine_conflict'),
    );
  });

  it('is closed and takes no tenant, store or device from the body', () => {
    const s = schema(pos, 'QuarantineSaleUpload');
    expect(s['additionalProperties']).toBe(false);
    const props = Object.keys(s['properties'] as object);
    expect(props.join(',')).not.toMatch(/tenant|store|deviceId|receivedAt/i);
  });

  it('stores the body as an opaque object, never a CaptureSaleRequest', () => {
    const body = (
      schema(pos, 'QuarantineSaleUpload')['properties'] as Record<string, Record<string, unknown>>
    )['saleBody'];
    expect(body).toMatchObject({ type: 'object' });
    expect(body!['$ref']).toBeUndefined();
    expect(body!['properties']).toBeUndefined();
    expect(
      validator(POS_ID, 'QuarantineSaleUpload')(upload({ saleBody: { anything: [1, 2] } })),
    ).toBe(true);
    expect(validator(POS_ID, 'QuarantineSaleUpload')(upload({ saleBody: 'x' }))).toBe(false);
  });

  it('bounds the idempotency key like the capture rule (RT-181)', () => {
    const v = validator(POS_ID, 'QuarantineSaleUpload');
    expect(v(upload())).toBe(true);
    expect(v(upload({ idempotencyKey: 'short' }))).toBe(false);
    expect(v(upload({ idempotencyKey: 'has a space in it ok' }))).toBe(false);
  });

  it('closes the reason kinds and keeps status and code nullable 4xx labels', () => {
    expect(schema(pos, 'QuarantineReason')['properties']).toMatchObject({
      kind: {
        enum: ['refused', 'payload_divergence', 'cashier_claim_refused', 'held_previous_pairing'],
      },
      httpStatus: { type: ['integer', 'null'], minimum: 400, maximum: 499 },
    });
    const v = validator(POS_ID, 'QuarantineReason');
    expect(v({ kind: 'held_previous_pairing', httpStatus: null, errorCode: null })).toBe(true);
    expect(v({ kind: 'refused', httpStatus: 500, errorCode: null })).toBe(false);
    expect(v({ kind: 'refused', httpStatus: 422, errorCode: 'Free Text!' })).toBe(false);
    expect(v({ kind: 'not_sendable', httpStatus: null, errorCode: null })).toBe(false);
    expect(pos.components?.schemas?.['QuarantineReason']).toBeDefined();
  });

  it('returns a receipt with no sale facts', () => {
    const v = validator(POS_ID, 'QuarantineReceipt');
    expect(v({ quarantineRef: REF, state: 'open', receivedAt: AT })).toBe(true);
    expect(v({ quarantineRef: REF, state: 'open', receivedAt: AT, posTotal: '1.00' })).toBe(false);
  });
});

describe('sale quarantine — the Console operations', () => {
  it('use the file-level cookieAuth session and the shared responses', () => {
    expect(ops.security).toEqual([{ cookieAuth: [] }]);
    for (const [, path, method] of CONSOLE_OPS) {
      const o = op(ops, path, method);
      expect(o.security).toBeUndefined();
      expect(o.responses?.['404']).toEqual({ $ref: '#/components/responses/NotFound' });
      expect(o.responses?.['429']).toEqual({ $ref: '#/components/responses/TooManyRequests' });
    }
  });

  it("repair needs the Console request's own Idempotency-Key and answers 409 repair_conflict", () => {
    const repair = op(ops, REPAIR, 'post');
    expect(repair['x-idempotency' as keyof OperationObject]).toBe('required');
    expect(repair.parameters).toEqual([
      { $ref: '#/components/parameters/QuarantineRef' },
      { $ref: '#/components/parameters/IdempotencyKey' },
    ]);
    expect(repair.responses?.['409']).toEqual({ $ref: '#/components/responses/RepairConflict' });
    expect(repair.responses?.['403']).toEqual({
      $ref: '#/components/responses/ForbiddenOrOriginRejected',
    });
    expect(repair.description).toEqual(expect.stringContaining("NOT the sale's capture key"));
  });

  it('states the one-sale-per-provenance guarantee and that it is not an interceptor replay', () => {
    const text = String(ops.info?.description);
    expect(text).toEqual(expect.stringContaining('At most one sale ever exists for a'));
    expect(text).toEqual(expect.stringContaining('not an interceptor replay'));
  });

  it('projects an item with no money and no stored body', () => {
    const props = Object.keys(schema(ops, 'QuarantinedSale')['properties'] as object);
    expect(props.join(',')).not.toMatch(/total|amount|saleBody|tenant/i);
    const v = validator(OPS_ID, 'QuarantinedSale');
    expect(v(item())).toBe(true);
    expect(
      v(
        item({
          state: 'captured',
          saleRef: REF,
          repairCount: 1,
          lastRepair: { at: AT, outcome: 'captured', httpStatus: null, errorCode: null },
        }),
      ),
    ).toBe(true);
    expect(v(item({ saleBody: {} }))).toBe(false);
    expect(v(item({ state: 'dismissed' }))).toBe(false);
  });

  it('pages at most 200 items, with a UUIDv7 cursor', () => {
    expect(schema(ops, 'QuarantinedSalePage')['properties']).toMatchObject({
      items: { maxItems: 200 },
    });
    expect(ops.components?.parameters?.['QuarantineCursor']).toMatchObject({
      name: 'cursor',
      schema: { pattern: expect.stringContaining('-7[0-9a-fA-F]{3}-') },
    });
  });

  it('keeps the QuarantineState values equal in both files', () => {
    expect(schema(ops, 'QuarantineState')['enum']).toEqual(schema(pos, 'QuarantineState')['enum']);
    expect(schema(ops, 'QuarantineReasonKind')['enum']).toEqual(
      (schema(pos, 'QuarantineReason')['properties'] as Record<string, Record<string, unknown>>)[
        'kind'
      ]!['enum'],
    );
  });
});

describe('sale quarantine — the existing NEEDS_REPAIR surface is unchanged', () => {
  it('keeps the four original operations without a contract-only marker', () => {
    for (const [path, method] of [
      ['/api/v1/catalog/sale-sync-ops/sales/{saleRef}/status', 'get'],
      ['/api/v1/catalog/sale-sync-ops/needs-repair', 'get'],
      ['/api/v1/catalog/sale-sync-ops/sales/{saleRef}/audit-timeline', 'get'],
      ['/api/v1/catalog/sale-sync-ops/sales/{saleRef}/repair', 'post'],
    ] as const) {
      expect(op(ops, path, method)['x-runtime-status']).toBeUndefined();
    }
  });

  it('keeps NeedsRepairItem keyed by the captured sale', () => {
    expect(schema(ops, 'NeedsRepairItem')).toMatchObject({
      additionalProperties: false,
      required: expect.arrayContaining(['saleRef', 'syncStatus']),
    });
  });
});

describe('sale quarantine — open owner questions are written down', () => {
  it.each([
    [POS_ID, ['Retention', 'another store', 'never sent', 'reaches the till']],
    [OPS_ID, ['Who may repair', 'created_by', 'payload_divergence', 'Retention', 'stored body']],
  ] as const)('%s lists its open owner questions', (id, phrases) => {
    const text = String((id === POS_ID ? pos : ops).info?.description);
    expect(text).toEqual(expect.stringContaining('Open owner questions'));
    for (const phrase of phrases) expect(text).toEqual(expect.stringContaining(phrase));
  });
});

/**
 * RT-1577 (RT-1511 S2), `[GATED: contract]`: `packages/contracts/openapi/inventory/pos-availability.yaml` 1.0.0-draft.
 *
 * Structural / load-only, plus AJV fixtures against the contract schemas. What this pins:
 *   1. One GET operation, `posGetStoreAvailability`, no write verb, no request body, no operationId collision.
 *   2. Security is the role-named `device` bearer scheme only; the query takes no tenant or store authority.
 *   3. The wire names the decision record fixed (RT-1511 section 4): `storeId`, `asOf`, `items[].productId`,
 *      `availableToSell`, `band`, `nextCursor`; the band is the closed set `in_stock | low | out`.
 *   4. Quantities are exact-decimal strings and may be negative; no money or float.
 *   5. Strict response schemas: valid payloads pass, invalid ones fail.
 *   6. The status set is the read-down's (200/400/401/404/500), and the rotation hints ride the 200.
 */
import 'reflect-metadata';

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import {
  allContracts,
  contractDocument,
  contractReader,
  operationIdsExcept,
  type ApiPath,
  type OpenApiDocument,
} from '../../_helpers/openapi-contract';

const CONTRACT_ID = 'pos-availability';
const PATH: ApiPath = '/api/pos/v1/inventory/availability';
const OPERATION_ID = 'posGetStoreAvailability';

type SchemaName = 'StoreAvailabilityPage' | 'StoreAvailabilityItem' | 'DecimalQuantity' | 'Error';

let doc: OpenApiDocument;
let otherOperationIds: Set<string>;
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

beforeAll(() => {
  const contracts = allContracts();
  doc = contractDocument(contracts, CONTRACT_ID);
  otherOperationIds = operationIdsExcept(contracts, CONTRACT_ID);
  ajv.addSchema(doc as object, CONTRACT_ID);
});

const op = () => contractReader(doc).get(PATH);

function validator(name: SchemaName): ValidateFunction {
  const compiled = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (compiled === undefined) throw new Error(`ajv cannot resolve ${name}`);
  return compiled;
}

const ITEM = { productId: '0190f5a2-3b4c-7d8e-9f01-00000000000a', availableToSell: '12.0000', band: 'low' };
const PAGE = {
  storeId: '0190f5a2-3b4c-7d8e-9f01-00000000000b',
  asOf: '2026-11-23T10:00:00.000Z',
  items: [ITEM],
  nextCursor: null,
};

describe('pos-availability — document and operation', () => {
  it('is an OpenAPI 3.1 draft with exactly one GET operation', () => {
    expect([doc.openapi, doc.info?.version]).toEqual(['3.1.0', '1.0.0-draft']);
    expect(Object.keys(doc.paths ?? {})).toEqual([PATH]);
    expect(Object.keys(doc.paths![PATH]!)).toEqual(['get']);
    expect(op().operationId).toBe(OPERATION_ID);
    expect(op().requestBody).toBeUndefined();
  });

  it('is served by the RT-1577 runtime: no contract-only marker', () => {
    expect(op()['x-runtime-status']).toBeUndefined();
    expect(op()['x-runtime-note']).toBeUndefined();
  });

  it('collides with no operationId of any other contract', () => {
    expect(otherOperationIds.has(OPERATION_ID)).toBe(false);
  });

  it('cites RT-1511 and the RT-1577 slice in its version note', () => {
    expect(doc.info?.description).toContain('RT-1577 (RT-1511 slice S2');
    expect(doc.info?.description).toContain('[GATED: contract]');
  });
});

describe('pos-availability — device authentication only', () => {
  it('secures the operation with the device bearer scheme and nothing else', () => {
    expect(doc.security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(['device']);
    expect(op().security).toEqual([{ device: [] }]);
    const scheme = doc.components!.securitySchemes!['device']!;
    expect([scheme['type'], scheme['scheme'], scheme['bearerFormat']]).toEqual(['http', 'bearer', undefined]);
  });

  it('takes no tenant or store authority from the query: branch_id is checked, never trusted', () => {
    expect(contractReader(doc).params(PATH).map((p) => p.name)).toEqual(['branch_id', 'cursor', 'limit']);
    for (const name of ['branch_id', 'cursor', 'limit']) {
      expect(contractReader(doc).param(PATH, name).required).toBe(false);
    }
  });

  it('bounds limit to 1-1000, default 500', () => {
    expect((contractReader(doc).param(PATH, 'limit').schema as Record<string, unknown>)).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 1000,
      default: 500,
    });
  });
});

describe('pos-availability — responses', () => {
  it('answers 200/400/401/404/500 as the catalogue read-down does', () => {
    expect(Object.keys(op().responses ?? {}).sort()).toEqual(['200', '400', '401', '404', '500']);
  });

  it('sends the device-token rotation hints on the 200', () => {
    expect(Object.keys(op().responses?.['200']?.headers ?? {})).toEqual([
      'X-Device-Token-Rotate-After',
      'X-Device-Token-Rotate-Stage',
    ]);
  });

  it('names the closed error code set of the surface', () => {
    for (const code of ['validation_error', 'unauthorized', 'not_found', 'internal_error']) {
      expect(doc.info?.description).toContain(code);
    }
    expect(contractReader(doc).responseDescription('Unauthorized')).toContain('store_context_required');
  });
});

describe('pos-availability — schemas', () => {
  const schema = (name: string) => contractReader(doc).schema(name) as Record<string, unknown>;

  it('closes the band set', () => {
    expect(schema('AvailabilityBand')['enum']).toEqual(['in_stock', 'low', 'out']);
  });

  it('accepts a valid page, an empty page that still has a cursor, and negative quantities', () => {
    expect(validator('StoreAvailabilityPage')(PAGE)).toBe(true);
    expect(validator('StoreAvailabilityPage')({ ...PAGE, items: [], nextCursor: 'opaque' })).toBe(true);
    expect(validator('StoreAvailabilityItem')({ ...ITEM, availableToSell: '-4.0000', band: 'out' })).toBe(true);
  });

  it.each([
    ['an unknown page field', { ...PAGE, tenantId: ITEM.productId }],
    ['a missing asOf', (({ asOf: _, ...rest }) => rest)(PAGE)],
    ['a missing nextCursor', (({ nextCursor: _, ...rest }) => rest)(PAGE)],
    ['an empty nextCursor (a continuation token is never empty; null ends the chain)', { ...PAGE, nextCursor: '' }],
    ['an item with an unknown band', { ...PAGE, items: [{ ...ITEM, band: 'critical' }] }],
    ['an item with a float quantity', { ...PAGE, items: [{ ...ITEM, availableToSell: 12 }] }],
    ['an item with an over-precise quantity', { ...PAGE, items: [{ ...ITEM, availableToSell: '1.23456' }] }],
    ['an item with an extra field', { ...PAGE, items: [{ ...ITEM, price: '1.00' }] }],
    ['a non-uuid product', { ...PAGE, items: [{ ...ITEM, productId: 'x' }] }],
  ])('refuses a page with %s', (_label, payload) => {
    expect(validator('StoreAvailabilityPage')(payload)).toBe(false);
  });

  it('says which responses are closed: the success schemas are, and the error envelope stays the canonical one', () => {
    // RT-1587: the description used to claim "the responses are additionalProperties: false", which the open Error does not honour.
    const description = String((doc.info as { description?: string }).description);
    expect(description).toMatch(/success responses are `additionalProperties: false`/);
    expect(description).not.toMatch(/The responses are `additionalProperties: false`/);
    expect(schema('StoreAvailabilityPage')['additionalProperties']).toBe(false);
    expect(schema('StoreAvailabilityItem')['additionalProperties']).toBe(false);
    expect(schema('Error')['additionalProperties']).toBeUndefined();
  });

  it('accepts the canonical error envelope', () => {
    expect(validator('Error')({ error: { code: 'not_found', message: 'not_found' } })).toBe(true);
  });
});

/**
 * RT-1599 (W9 slice A, N2), `[GATED: contract]`: `packages/contracts/openapi/inventory/redistribution-proposals.yaml`
 * 1.0.0-draft.
 *
 * Structural / load-only, plus AJV checks of every named example against its schema. What this pins:
 *   1. The six operations, their verbs and paths, and no operationId collision with any other contract.
 *   2. Cookie session only; every command requires `Idempotency-Key` and declares `x-idempotency: required` and 425.
 *   3. The non-disclosing 404 covers role, tenant, unknown id and feature-off; 403 is only `origin_rejected`.
 *   4. The closed proposal state set and the error-code set the description promises.
 *   5. Request bodies are strict and take no tenant, actor or read-time authority.
 *   6. Every named example (each state, each error) validates against its schema.
 *   7. Until RT-1600 serves an operation, its contract-only marker names RT-1600.
 */
import 'reflect-metadata';

import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

import {
  allContracts,
  contractDocument,
  operationIdsExcept,
  type OpenApiDocument,
  type OperationObject,
} from '../../_helpers/openapi-contract';

const CONTRACT_ID = 'redistribution-proposals';
const BASE = '/api/inventory/v1/redistribution-proposals';

const OPERATIONS = {
  createRedistributionProposal: ['post', BASE],
  listRedistributionProposals: ['get', BASE],
  getRedistributionProposal: ['get', `${BASE}/{proposalId}`],
  reviewRedistributionProposal: ['post', `${BASE}/{proposalId}/review`],
  acceptRedistributionProposal: ['post', `${BASE}/{proposalId}/accept`],
  rejectRedistributionProposal: ['post', `${BASE}/{proposalId}/reject`],
} as const;
type OperationId = keyof typeof OPERATIONS;
const COMMANDS: OperationId[] = [
  'createRedistributionProposal',
  'reviewRedistributionProposal',
  'acceptRedistributionProposal',
  'rejectRedistributionProposal',
];
const READS: OperationId[] = ['listRedistributionProposals', 'getRedistributionProposal'];

const STATES = ['open', 'reviewed', 'partially_accepted', 'accepted', 'rejected', 'expired', 'superseded'];
const ERROR_CODES = [
  'validation_error',
  'idempotency_key_required',
  'idempotency_key_malformed',
  'unauthorized',
  'origin_rejected',
  'not_found',
  'idempotency_key_conflict',
  'proposal_superseded',
  'proposal_expired',
  'proposal_state_conflict',
  'proposal_line_already_decided',
  'proposal_stale',
  'redistribution_too_large',
  'redistribution_deadline_exceeded',
  'redistribution_plan_invalid',
  'idempotency_in_progress',
  'rate_limited',
  'internal_error',
];

type Json = Record<string, unknown>;

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

function op(id: OperationId): OperationObject {
  const [verb, path] = OPERATIONS[id];
  const found = (doc.paths?.[path] as Record<string, OperationObject> | undefined)?.[verb];
  if (!found) throw new Error(`${verb.toUpperCase()} ${path} not declared`);
  return found;
}

function deref(value: unknown): Json {
  const record = value as Json;
  const ref = record['$ref'];
  if (typeof ref !== 'string') return record;
  const [, , section, name] = ref.split('/');
  return (doc.components as Record<string, Record<string, Json>>)[section!]![name!]!;
}

function paramNames(id: OperationId): string[] {
  const [, path] = OPERATIONS[id];
  const pathParams = ((doc.paths?.[path] as Json)['parameters'] as unknown[] | undefined) ?? [];
  return [...pathParams, ...((op(id).parameters as unknown[] | undefined) ?? [])].map((p) => String(deref(p)['name']));
}

function validator(name: string): ValidateFunction {
  const compiled = ajv.getSchema(`${CONTRACT_ID}#/components/schemas/${name}`);
  if (compiled === undefined) throw new Error(`ajv cannot resolve ${name}`);
  return compiled;
}

describe('redistribution-proposals — document and operations', () => {
  it('is an OpenAPI 3.1 draft with exactly the six operations', () => {
    expect([doc.openapi, doc.info?.version]).toEqual(['3.1.0', '1.0.0-draft']);
    const declared = Object.entries(doc.paths ?? {}).flatMap(([path, item]) =>
      Object.entries(item as Json)
        .filter(([verb]) => ['get', 'post', 'put', 'patch', 'delete'].includes(verb))
        .map(([verb, o]) => [(o as OperationObject).operationId, verb, path]),
    );
    expect(declared.sort()).toEqual(
      Object.entries(OPERATIONS)
        .map(([id, [verb, path]]) => [id, verb, path])
        .sort(),
    );
  });

  it('collides with no operationId of any other contract', () => {
    for (const id of Object.keys(OPERATIONS)) expect(otherOperationIds.has(id)).toBe(false);
  });

  it('cites RT-1599 and the gate in its version note', () => {
    expect(doc.info?.description).toContain('RT-1599 (W9 slice A');
    expect(doc.info?.description).toContain('[GATED: contract]');
  });

  it('marks an operation contract-only only with a note naming the RT-1600 runtime', () => {
    for (const id of Object.keys(OPERATIONS) as OperationId[]) {
      const o = op(id) as Json;
      if (o['x-runtime-status'] === undefined) continue;
      expect([id, o['x-runtime-status']]).toEqual([id, 'contract-only']);
      expect(String(o['x-runtime-note'])).toContain('RT-1600');
    }
  });
});

describe('redistribution-proposals — authentication and idempotency', () => {
  it('secures every operation with the console cookie session only', () => {
    expect(doc.security).toBeUndefined();
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toEqual(['cookieAuth']);
    for (const id of Object.keys(OPERATIONS) as OperationId[]) expect(op(id).security).toEqual([{ cookieAuth: [] }]);
  });

  it('requires Idempotency-Key, x-idempotency and a 425 on every command, and on no read', () => {
    for (const id of COMMANDS) {
      expect([id, paramNames(id).includes('Idempotency-Key')]).toEqual([id, true]);
      expect([id, (op(id) as Json)['x-idempotency']]).toEqual([id, 'required']);
      expect([id, '425' in (op(id).responses ?? {})]).toEqual([id, true]);
    }
    for (const id of READS) {
      expect([id, paramNames(id).includes('Idempotency-Key')]).toEqual([id, false]);
      expect([id, '425' in (op(id).responses ?? {})]).toEqual([id, false]);
    }
    const key = deref({ $ref: '#/components/parameters/IdempotencyKey' });
    expect([key['in'], key['required']]).toEqual(['header', true]);
    expect(key['schema']).toMatchObject({ type: 'string', minLength: 16, maxLength: 128 });
  });
});

describe('redistribution-proposals — non-disclosing refusals', () => {
  it('answers 404 with the one non-disclosing response, and 403 only for origin_rejected', () => {
    for (const id of Object.keys(OPERATIONS) as OperationId[]) {
      const responses = op(id).responses as Record<string, Json>;
      expect([id, responses['404']]).toEqual([id, { $ref: '#/components/responses/NotFoundNonDisclosing' }]);
      expect([id, responses['403']]).toEqual([id, { $ref: '#/components/responses/OriginRejected' }]);
    }
    const notFound = String(deref({ $ref: '#/components/responses/NotFoundNonDisclosing' })['description']);
    for (const words of ['another tenant', 'owner or tenant_admin', 'feature is off', 'indistinguishable']) {
      expect(notFound).toContain(words);
    }
  });

  it('lets accept depend on the live phase: a shadow-only tenant is the same 404', () => {
    expect(op('acceptRedistributionProposal').description).toContain('LIVE allowlist');
    expect(op('acceptRedistributionProposal').description).toContain('shadow-only tenant');
  });
});

describe('redistribution-proposals — states, codes and outcomes', () => {
  it('has the closed state set', () => {
    expect((doc.components!.schemas!['RedistributionProposalState'] as Json)['enum']).toEqual(STATES);
  });

  it('documents every error code in the version note and gives each a named example', () => {
    const description = String(doc.info?.description);
    const exampleCodes = new Set<string>();
    for (const response of Object.values(doc.components?.responses ?? {}) as Json[]) {
      const examples = ((response['content'] as Json)['application/json'] as Json)['examples'] as
        | Record<string, Json>
        | undefined;
      for (const example of Object.values(examples ?? {})) {
        const value = example['value'] as Json;
        exampleCodes.add(typeof value['error'] === 'string' ? value['error'] : String((value['error'] as Json)['code']));
      }
    }
    for (const code of ERROR_CODES) {
      expect([code, description.includes(`\`${code}\``)]).toEqual([code, true]);
      expect([code, exampleCodes.has(code)]).toEqual([code, true]);
    }
  });

  it('accept never approves or dispatches: it creates W3 drafts only', () => {
    const description = String(op('acceptRedistributionProposal').description);
    expect(description).toContain('shipment transfer in `draft`');
    expect(description).toContain('never');
    expect(description).toContain('ONE transaction');
  });
});

describe('redistribution-proposals — strict request bodies', () => {
  const COMMAND_SCHEMAS = [
    'ComputeRedistributionProposalCommand',
    'ReviewRedistributionProposalCommand',
    'AcceptRedistributionProposalCommand',
    'RejectRedistributionProposalCommand',
  ];

  it('closes every command schema and accepts no tenant, actor or read time', () => {
    for (const name of COMMAND_SCHEMAS) {
      const schema = doc.components!.schemas![name] as Json;
      expect([name, schema['additionalProperties']]).toEqual([name, false]);
      for (const forbidden of ['tenantId', 'createdBy', 'computedAt', 'readAt', 'userId']) {
        expect(Object.keys((schema['properties'] as Json) ?? {})).not.toContain(forbidden);
      }
    }
  });

  it('validates good command bodies and refuses bad ones', () => {
    const uuid = '0190f5a2-3b4c-7d8e-9f01-0000000000d1';
    const cases: Array<[string, unknown, boolean]> = [
      ['ComputeRedistributionProposalCommand', {}, true],
      ['ComputeRedistributionProposalCommand', { storeIds: [uuid] }, false],
      ['ComputeRedistributionProposalCommand', { tenantId: uuid }, false],
      ['ReviewRedistributionProposalCommand', { lineDecisions: [{ lineId: uuid, decision: 'would_accept' }] }, true],
      ['ReviewRedistributionProposalCommand', { lineDecisions: [{ lineId: uuid, decision: 'accept' }] }, false],
      ['AcceptRedistributionProposalCommand', { lineIds: [uuid] }, true],
      ['AcceptRedistributionProposalCommand', { lineIds: [] }, false],
      ['RejectRedistributionProposalCommand', { reason: 'Already on order.' }, true],
      ['RejectRedistributionProposalCommand', { reason: '' }, false],
    ];
    for (const [name, body, ok] of cases) expect([name, body, validator(name)(body)]).toEqual([name, body, ok]);
  });
});

describe('redistribution-proposals — examples validate against their schemas', () => {
  it('has one valid example per proposal state on the get response', () => {
    const content = ((op('getRedistributionProposal').responses as Record<string, Json>)['200']!['content'] as Json)[
      'application/json'
    ] as Json;
    const examples = content['examples'] as Record<string, Json>;
    expect(Object.keys(examples).sort()).toEqual([...STATES].sort());
    const validate = validator('RedistributionProposal');
    for (const [name, example] of Object.entries(examples)) {
      const value = example['value'] as Json;
      expect([name, value['state']]).toEqual([name, name]);
      expect([name, validate(value), validate.errors ?? null]).toEqual([name, true, null]);
    }
  });

  it('validates every error example against its response schema', () => {
    for (const [responseName, response] of Object.entries(doc.components?.responses ?? {}) as Array<[string, Json]>) {
      const content = (response['content'] as Json)['application/json'] as Json;
      const schemaName = String(((content['schema'] as Json)['$ref'] as string).split('/').pop());
      const validate = validator(schemaName);
      for (const [name, example] of Object.entries((content['examples'] as Record<string, Json>) ?? {})) {
        expect([responseName, name, validate(example['value'])]).toEqual([responseName, name, true]);
      }
    }
  });

  it('refuses a stored proposal whose validator did not pass or which has no line', () => {
    const validate = validator('RedistributionValidatorReport');
    expect(validate({ passed: true, violations: [] })).toBe(true);
    expect(validate({ passed: false, violations: [{ code: 'source_floor_breached' }] })).toBe(false);
    const line = validator('RedistributionProposalLine');
    expect(
      line({
        id: '0190f5a2-3b4c-7d8e-9f01-0000000000d1',
        productId: '0190f5a2-3b4c-7d8e-9f01-0000000000e1',
        sourceStoreId: '0190f5a2-3b4c-7d8e-9f01-0000000000b1',
        destinationStoreId: '0190f5a2-3b4c-7d8e-9f01-0000000000b3',
        quantity: '0',
        stockingUnit: 'piece',
        warnings: [],
        reviewDecision: null,
        acceptOutcome: null,
      }),
    ).toBe(false);
  });
});

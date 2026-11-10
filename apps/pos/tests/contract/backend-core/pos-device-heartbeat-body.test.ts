/**
 * RT-1312 Phase 1 — the heartbeat body the POS builds against the PINNED
 * Backend-Core contract (`contracts/backend-core/openapi/pos-device-health.openapi.yaml`,
 * at the commit in `contracts/backend-core/PIN`).
 *
 * A 400 stores nothing, so every body `buildHeartbeatBody` can produce must
 * satisfy `DeviceHeartbeatReport`. The POS has no JSON-Schema validator on its
 * dependency tree (adding one is a gated package change), so this checks the
 * subset of JSON Schema the schema uses: `$ref`, `oneOf`, `type`, `enum`,
 * `pattern`, `minLength`/`maxLength`, `minimum`/`maximum`, `format: date-time`,
 * `required` and `additionalProperties: false`. A keyword it does not know fails
 * the test, so a re-pin that tightens the schema cannot pass silently.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import jsYaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

import {
  buildHeartbeatBody,
  type HeartbeatFacts,
} from '../../../src/main/device-health/heartbeat-wire.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACT = path.join(
  REPO_ROOT,
  'contracts/backend-core/openapi/pos-device-health.openapi.yaml',
);
type Schema = Record<string, unknown>;
const DOC = (jsYaml as { load: (src: string) => unknown }).load(
  readFileSync(CONTRACT, 'utf-8'),
) as { components: { schemas: Record<string, Schema> } };
const SCHEMAS = DOC.components.schemas;

const KNOWN = new Set([
  '$ref',
  'oneOf',
  'type',
  'enum',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'format',
  'properties',
  'required',
  'additionalProperties',
  'description',
]);
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

/** Violations of `schema` by `value`, as `path: reason` strings. */
function violations(schema: Schema, value: unknown, at: string): string[] {
  const unknown = Object.keys(schema).filter((k) => !KNOWN.has(k));
  if (unknown.length > 0) return [`${at}: unsupported keyword(s) ${unknown.join(', ')}`];
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const target = SCHEMAS[ref.split('/').pop() ?? ''];
    return target === undefined ? [`${at}: dangling ${ref}`] : violations(target, value, at);
  }
  const oneOf = schema['oneOf'] as Schema[] | undefined;
  if (oneOf !== undefined) {
    const passing = oneOf.filter((branch) => violations(branch, value, at).length === 0);
    return passing.length === 1 ? [] : [`${at}: ${String(passing.length)} oneOf branches match`];
  }
  return [...scalarViolations(schema, value, at), ...objectViolations(schema, value, at)];
}

function scalarViolations(schema: Schema, value: unknown, at: string): string[] {
  const out: string[] = [];
  const types = [schema['type']].flat().filter((t) => t !== undefined) as string[];
  const actual = typeOf(value);
  const typeOk =
    types.length === 0 ||
    types.some((t) => t === actual || (t === 'number' && actual === 'integer'));
  if (!typeOk) out.push(`${at}: ${actual} is not ${types.join('|')}`);
  const en = schema['enum'] as unknown[] | undefined;
  if (en !== undefined && !en.includes(value)) out.push(`${at}: not in enum`);
  if (typeof value === 'string') {
    const pattern = schema['pattern'] as string | undefined;
    if (pattern !== undefined && !new RegExp(pattern).test(value)) out.push(`${at}: pattern`);
    const min = schema['minLength'] as number | undefined;
    const max = schema['maxLength'] as number | undefined;
    if (min !== undefined && value.length < min) out.push(`${at}: minLength`);
    if (max !== undefined && value.length > max) out.push(`${at}: maxLength`);
    if (schema['format'] === 'date-time' && !DATE_TIME.test(value)) out.push(`${at}: date-time`);
  }
  if (typeof value === 'number') {
    const min = schema['minimum'] as number | undefined;
    const max = schema['maximum'] as number | undefined;
    if (min !== undefined && value < min) out.push(`${at}: minimum`);
    if (max !== undefined && value > max) out.push(`${at}: maximum`);
  }
  return out;
}

function objectViolations(schema: Schema, value: unknown, at: string): string[] {
  const props = schema['properties'] as Record<string, Schema> | undefined;
  if (props === undefined || typeOf(value) !== 'object') return [];
  const record = value as Record<string, unknown>;
  const out: string[] = [];
  for (const key of (schema['required'] as string[] | undefined) ?? []) {
    if (!(key in record)) out.push(`${at}.${key}: required`);
  }
  for (const [key, v] of Object.entries(record)) {
    const prop = props[key];
    if (prop === undefined) {
      if (schema['additionalProperties'] === false) out.push(`${at}.${key}: not declared`);
      continue;
    }
    out.push(...violations(prop, v, `${at}.${key}`));
  }
  return out;
}

const REPORT = SCHEMAS['DeviceHeartbeatReport'] as Schema;

const FULL: HeartbeatFacts = {
  appVersion: '1.4.0',
  updateChannel: 'stable',
  updateState: 'update_pending',
  pendingVersion: '1.5.0-rc.1',
  schemaHead: '0060_tenant_branding_cache',
  sourceClockAt: new Date('2026-11-10T12:00:00.000Z'),
  saleQueue: {
    pending: 2,
    deadLetter: 1,
    heldPreviousPairing: 0,
    oldestPendingAt: '2026-11-10T11:58:00.000Z',
  },
};

const UNKNOWN: HeartbeatFacts = {
  appVersion: null,
  updateChannel: null,
  updateState: null,
  pendingVersion: null,
  schemaHead: null,
  sourceClockAt: new Date('2026-11-10T12:00:00.000Z'),
  saleQueue: null,
};

const OFF_CONTRACT: HeartbeatFacts = {
  appVersion: '1.4.0+build.7',
  updateChannel: 'beta',
  updateState: 'paused',
  pendingVersion: '1.4',
  schemaHead: '../migrations',
  sourceClockAt: new Date('2026-11-10T12:00:00.000Z'),
  saleQueue: {
    pending: 5_000_000,
    deadLetter: -1,
    heldPreviousPairing: Number.NaN,
    oldestPendingAt: 'yesterday',
  },
};

describe('the POS heartbeat body satisfies the pinned DeviceHeartbeatReport', () => {
  it('reads the schema as closed', () => {
    expect(REPORT['additionalProperties']).toBe(false);
    expect(Object.keys(REPORT['properties'] as object)).toContain('sale_queue');
  });

  it.each([
    ['every field known, gate open', FULL, true],
    ['every field known, gate closed', FULL, false],
    ['every field unknown, gate open', UNKNOWN, true],
    ['every field unknown, gate closed', UNKNOWN, false],
    ['off-contract values, gate open', OFF_CONTRACT, true],
  ])('%s', (_name, facts, includeSaleQueue) => {
    const body = buildHeartbeatBody(facts, { includeSaleQueue });
    expect(violations(REPORT, body, 'body')).toEqual([]);
  });

  it('names every self-reported property of the schema except sale_queue in every beat', () => {
    const declared = Object.keys(REPORT['properties'] as object).filter((k) => k !== 'sale_queue');
    expect(Object.keys(buildHeartbeatBody(UNKNOWN, { includeSaleQueue: false })).sort()).toEqual(
      declared.sort(),
    );
  });

  it('would catch an undeclared key (the checker is not vacuous)', () => {
    expect(violations(REPORT, { device_id: 'x' }, 'body')).toEqual([
      'body.device_id: not declared',
    ]);
  });
});

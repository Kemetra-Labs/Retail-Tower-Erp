/**
 * RT-1231 — the POS audit sender against the PINNED Backend-Core contract
 * (`contracts/backend-core/openapi/pos-audit-events.openapi.yaml`, 1.3.0-draft
 * at the commit in `contracts/backend-core/PIN`; refresh with
 * `npm run contracts:repin`).
 *
 *   • every category the POS uploads (RT-160 D-2) is in the contract's closed
 *     `action_category` enum, so none is refused for its category;
 *   • D-2 keeps routine `shift.open` / `shift.close` local even though the
 *     contract still accepts them;
 *   • the request the client sends is strict-conformant: body keys
 *     (`additionalProperties: false`), required keys, and each event item's
 *     keys and formats;
 *   • `schema_violation` is still a declared rejection category (the one the
 *     sender treats as final).
 * A re-pin that drops a category, renames a field or adds a required one
 * fails here.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { buildTree, child, type YamlNode } from './yaml-tree.js';
import { CENTRAL_AUDIT_CATEGORIES } from '../../../src/main/audit/central-audit-categories.js';
import { createAuditSyncClient } from '../../../src/main/audit/audit-sync-client.js';
import { isWireReady } from '../../../src/main/audit/audit-event-wire.js';
import type { AuditEvent } from '../../../src/shared/audit/event-shape.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CONTRACT = path.join(
  REPO_ROOT,
  'contracts/backend-core/openapi/pos-audit-events.openapi.yaml',
);
const ROOT = buildTree({ name: 'pos-audit-events', text: readFileSync(CONTRACT, 'utf-8') });

function at(node: YamlNode | undefined, key: string): YamlNode {
  const found = node === undefined ? undefined : child(node, key);
  if (found === undefined) throw new Error(`pos-audit-events contract: missing "${key}"`);
  return found;
}

function listOf(node: YamlNode): string[] {
  if (node.value.startsWith('[')) return node.value.match(/[^\s,[\]]+/g) ?? [];
  return node.children.filter((c) => c.item).map((c) => c.value);
}

const SCHEMAS = at(at(ROOT, 'components'), 'schemas');
const ITEM = at(SCHEMAS, 'AuditEventItem');
const ITEM_PROPS = at(ITEM, 'properties');
const CATALOGUE = listOf(at(at(ITEM_PROPS, 'action_category'), 'enum'));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function event(category: string): AuditEvent {
  return {
    event_id: '00000000-0000-4000-8000-000000000001',
    tenant_id: '11111111-1111-4111-8111-111111111111',
    branch_id: '33333333-3333-4333-8333-333333333333',
    originating_terminal_id: '44444444-4444-4444-8444-444444444444',
    acting_operator_id: 'user_clerk1',
    session_id: '55555555-5555-4555-8555-555555555555',
    shift_id: null,
    action_category: category as AuditEvent['action_category'],
    created_at: '2026-11-06T10:00:00.000Z',
    approving_supervisor_id: null,
    payload: {},
  };
}

/** The `type` of a property: a scalar or a flow list such as `[string, "null"]`. */
function typesOf(prop: YamlNode): string[] {
  const type = child(prop, 'type');
  return type === undefined ? [] : listOf(type).map((t) => t.replace(/"/g, ''));
}

function checkItemField(key: string, value: unknown): void {
  const prop = at(ITEM_PROPS, key);
  if (value === null) {
    expect(typesOf(prop)).toContain('null');
    return;
  }
  const format = child(prop, 'format')?.value;
  if (format === 'uuid') expect(value).toMatch(UUID);
  if (format === 'date-time') expect(value).toMatch(DATE_TIME);
  if (typesOf(prop).includes('object')) expect(typeof value).toBe('object');
  const enumNode = child(prop, 'enum');
  if (enumNode !== undefined) expect(listOf(enumNode)).toContain(value);
}

describe('RT-1231 audit sender conforms to the pinned pos-audit-events contract', () => {
  it('pins pos-audit-events 1.3.0-draft (RT-1230)', () => {
    expect(at(at(ROOT, 'info'), 'version').value).toBe('1.3.0-draft');
  });

  it.each(CENTRAL_AUDIT_CATEGORIES)('%s is in the accepted action_category enum', (category) => {
    expect(CATALOGUE).toContain(category);
  });

  it('keeps routine shift.open / shift.close local (RT-160 D-2)', () => {
    expect(CATALOGUE).toEqual(expect.arrayContaining(['shift.open', 'shift.close']));
    expect(CENTRAL_AUDIT_CATEGORIES).not.toContain('shift.open');
    expect(CENTRAL_AUDIT_CATEGORIES).not.toContain('shift.close');
  });

  it('uploads every catalogue category except the D-2 local ones', () => {
    const notUploaded = CATALOGUE.filter(
      (c) => !(CENTRAL_AUDIT_CATEGORIES as readonly string[]).includes(c),
    );
    expect(notUploaded.sort()).toEqual(['shift.close', 'shift.open']);
  });

  it('declares schema_violation as a rejection category', () => {
    const rejected = at(at(at(SCHEMAS, 'RejectedEvent'), 'properties'), 'category');
    expect(listOf(at(rejected, 'enum'))).toEqual(
      expect.arrayContaining(['invalid_input', 'tenant_mismatch', 'schema_violation']),
    );
  });

  it('sends a strict-conformant request body for each uploaded category', async () => {
    const fetch = vi.fn<(url: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(() =>
      Promise.resolve(
        new Response(JSON.stringify({ accepted: [], duplicates: [], rejected: [] }), {
          status: 200,
        }),
      ),
    );
    const client = createAuditSyncClient({
      baseUrl: 'https://bc.test',
      fetch,
      readDeviceToken: () => Promise.resolve('device-token'),
    });
    const events = CENTRAL_AUDIT_CATEGORIES.map(event);
    for (const e of events) expect(isWireReady(e)).toBe(true);
    await client.sendBatch(events);

    const request = at(SCHEMAS, 'PosAuditEventsSyncRequest');
    const body = JSON.parse(fetch.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(at(request, 'additionalProperties').value).toBe('false');
    expect(Object.keys(body).sort()).toEqual(
      at(request, 'properties')
        .children.map((c) => c.key)
        .sort(),
    );
    expect(Object.keys(body)).toEqual(expect.arrayContaining(listOf(at(request, 'required'))));
    const maxItems = Number(at(at(at(request, 'properties'), 'events'), 'maxItems').value);
    expect(events.length).toBeLessThanOrEqual(maxItems);

    expect(at(ITEM, 'additionalProperties').value).toBe('false');
    const declared = ITEM_PROPS.children.map((c) => c.key);
    for (const item of body['events'] as Array<Record<string, unknown>>) {
      expect(declared).toEqual(expect.arrayContaining(Object.keys(item)));
      expect(Object.keys(item)).toEqual(expect.arrayContaining(listOf(at(ITEM, 'required'))));
      for (const [key, value] of Object.entries(item)) checkItemField(key, value);
    }
  });
});

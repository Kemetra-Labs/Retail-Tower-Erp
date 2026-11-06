/**
 * RT-1231 — the `AuditEventItem` of `pos-audit-events` 1.3.0-draft, POS side.
 *
 * Backend-Core validates the request body as a whole before it looks at any
 * single event: ONE event with a malformed field makes the whole batch a 400,
 * every time it is re-sent. So the sender checks each event against the
 * contract's field formats first, and an event that cannot pass is settled
 * locally as final instead of being sent (`audit-sync.ts`). The payload rules
 * per category stay with Backend-Core: those are per-event `schema_violation`
 * rejections, which do not block the batch.
 *
 * Formats as the contract states them: `uuid` ids (8-4-4-4-12 hex), a UTC
 * `date-time` with `Z`, non-empty operator ids, an object payload.
 */
import type { AuditEvent } from '../../shared/audit/event-shape.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID.test(value);
}

function isNullableUuid(value: unknown): boolean {
  return value === null || value === undefined || isUuid(value);
}

function isNonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

function isPayloadObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when every field of the event has the format the contract requires. */
export function isWireReady(event: AuditEvent): boolean {
  return (
    isUuid(event.event_id) &&
    isUuid(event.tenant_id) &&
    isUuid(event.branch_id) &&
    isUuid(event.originating_terminal_id) &&
    isNonEmpty(event.acting_operator_id) &&
    isNullableUuid(event.session_id) &&
    isNullableUuid(event.shift_id) &&
    isNonEmpty(event.action_category) &&
    typeof event.created_at === 'string' &&
    UTC_DATE_TIME.test(event.created_at) &&
    (event.approving_supervisor_id === null || isNonEmpty(event.approving_supervisor_id)) &&
    isPayloadObject(event.payload)
  );
}

/** The wire item: exactly the contract's keys (`additionalProperties: false`). */
export function toWireEvent(event: AuditEvent): Record<string, unknown> {
  return {
    event_id: event.event_id,
    tenant_id: event.tenant_id,
    branch_id: event.branch_id,
    originating_terminal_id: event.originating_terminal_id,
    acting_operator_id: event.acting_operator_id,
    session_id: event.session_id,
    shift_id: event.shift_id,
    action_category: event.action_category,
    created_at: event.created_at,
    approving_supervisor_id: event.approving_supervisor_id,
    payload: event.payload,
  };
}

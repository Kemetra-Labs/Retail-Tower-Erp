/**
 * RT-1057 — `inventory.movement.created` outbox consumer (acknowledge-only).
 *
 * Three emitters write `inventory.movement.created` to the outbox, but no
 * projection consumes it yet. Without a registered consumer the drainer logs
 * `UnroutableEventType`, retries the row up to `MAX_ATTEMPTS` and then
 * dead-letters it (RT-1035). This placeholder acknowledges the event so the
 * row ends `delivered` at the first attempt. The event stays emitted for a
 * future projection, which will replace this class.
 *
 * No side effects
 * ---------------
 * `handle()` does nothing: no DB access, no queue, no external call, no
 * logging. In particular the payload is never read or logged (movement
 * payloads are IDs/provenance only, but lifecycle.md §7 still forbids logging
 * payloads). Delivery state is written by the drainer, not by this class.
 */
import type { OutboxConsumer, OutboxEventEnvelope } from "@data-pulse-2/shared";

/** Stable consumer id, `<domain>.<event_type>` like the other consumers. */
export const INVENTORY_MOVEMENT_CREATED_CONSUMER_ID = "worker.inventory.movement.created";

export class InventoryMovementCreatedConsumer implements OutboxConsumer<unknown> {
  readonly consumerId = INVENTORY_MOVEMENT_CREATED_CONSUMER_ID;
  readonly eventType = "inventory.movement.created";

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handle(_event: OutboxEventEnvelope<unknown>): Promise<void> {
    // Intentionally empty: acknowledge only (RT-1057).
  }
}

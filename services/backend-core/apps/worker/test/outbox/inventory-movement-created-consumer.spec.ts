/**
 * RT-1057 — InventoryMovementCreatedConsumer (acknowledge-only) unit test.
 * No Docker, no Postgres, no Redis.
 */
import {
  InventoryMovementCreatedConsumer,
  INVENTORY_MOVEMENT_CREATED_CONSUMER_ID,
} from "../../src/outbox/consumers/inventory-movement-created.consumer";
import { OutboxConsumerRegistry } from "../../src/outbox/registry";
import { OUTBOX_EVENT_TYPES } from "@data-pulse-2/db";
import type { OutboxEventEnvelope } from "@data-pulse-2/shared";

const envelope: OutboxEventEnvelope<unknown> = {
  event_id: "0e000000-0000-4000-8000-0000000000a1",
  event_type: "inventory.movement.created",
  tenant_id: "00000000-0000-7000-8000-000000000030",
  store_id: "00000000-0000-7000-8000-000000000020",
  payload: { movement_id: "00000000-0000-7000-8000-000000000010" },
  correlation_id: "00000000-0000-7000-8000-000000000040",
  occurred_at: new Date("2026-11-02T00:00:00Z"),
  attempts: 1,
} as OutboxEventEnvelope<unknown>;

describe("RT-1057 InventoryMovementCreatedConsumer", () => {
  it("surface: eventType matches the registered outbox type and the consumer id is stable", () => {
    const c = new InventoryMovementCreatedConsumer();
    expect(c.eventType).toBe(OUTBOX_EVENT_TYPES.INVENTORY_MOVEMENT_CREATED);
    expect(c.consumerId).toBe(INVENTORY_MOVEMENT_CREATED_CONSUMER_ID);
    expect(c.consumerId).toBe("worker.inventory.movement.created");
  });

  it("acknowledges: resolves without throwing", async () => {
    await expect(new InventoryMovementCreatedConsumer().handle(envelope)).resolves.toBeUndefined();
  });

  it("has no side effects: does not touch the payload (frozen, throwing getters) and logs nothing", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      jest.spyOn(console, m).mockImplementation(() => undefined),
    );
    try {
      const hostile = {
        ...envelope,
        get payload(): unknown {
          throw new Error("payload must not be read");
        },
      } as unknown as OutboxEventEnvelope<unknown>;
      await expect(new InventoryMovementCreatedConsumer().handle(hostile)).resolves.toBeUndefined();
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  it("registry resolves it for the type; a second registration is rejected", () => {
    const registry = new OutboxConsumerRegistry();
    registry.register(new InventoryMovementCreatedConsumer());
    expect(registry.resolve("inventory.movement.created")?.consumerId).toBe(
      INVENTORY_MOVEMENT_CREATED_CONSUMER_ID,
    );
    expect(() => registry.register(new InventoryMovementCreatedConsumer())).toThrow(/duplicate/);
  });
});

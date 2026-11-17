/**
 * RT-1440 (U1) A3: each readiness blocker row gets one deep link from its structured `subject`
 * (RT-1444): the device whose heartbeat or sale queue cannot be trusted, or the warehouse ref.
 * The server words are never read; an absent, empty or malformed subject gives no link.
 */
import { subjectLinkOf } from "@/count-sessions/activationDetails";
import { describe, expect, it } from "vitest";

const DEVICE = "0198a0c4-0000-7000-8000-000000000d01";

describe("subjectLinkOf", () => {
  it("a device subject links to the device page, where the close or the retire is offered", () => {
    expect(subjectLinkOf({ deviceId: DEVICE })).toEqual({
      to: `/devices/${DEVICE}`,
      labelKey: "counts.activation.link.device",
    });
  });

  it("a warehouse subject links to the ERP mappings", () => {
    expect(subjectLinkOf({ warehouseRef: "Stores - RT" })).toEqual({
      to: "/erp-connection/mappings",
      labelKey: "counts.activation.link.warehouse",
    });
  });

  it("no subject, an empty subject or a malformed one gives no link", () => {
    expect(subjectLinkOf(undefined)).toBeNull();
    expect(subjectLinkOf(null)).toBeNull();
    expect(subjectLinkOf({})).toBeNull();
    expect(subjectLinkOf({ deviceId: "not-a-uuid" })).toBeNull();
    expect(subjectLinkOf({ warehouseRef: "" })).toBeNull();
    expect(subjectLinkOf({ deviceId: 7 })).toBeNull();
  });
});

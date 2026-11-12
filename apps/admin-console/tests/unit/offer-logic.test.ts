import {
  buildPauseBody,
  dedupeById,
  offerAccess,
  offerActions,
  offerStateBadgeClass,
  offerStateKey,
  pausableStores,
  scheduleText,
} from "@/offers/offerLogic";
import { describe, expect, test } from "vitest";
import { STORE_A, STORE_B, definition, draftOffer, offer } from "./offer-fixtures";

/**
 * RT-1338 (RT-286 S6): who may do what to an offer, and which lifecycle controls a state offers.
 * The Console mirrors OD-12 to show or hide controls; Backend-Core stays the authority.
 */

describe("offerAccess (OD-12)", () => {
  test("owner and tenant_admin manage, publish and pause, whole offer included", () => {
    for (const role of ["owner", "tenant_admin"]) {
      expect(offerAccess(role, "all")).toEqual({
        canRead: true,
        canManage: true,
        canPublish: true,
        canPause: true,
        canPauseWhole: true,
        tenantWide: true,
      });
    }
  });

  test("a store_manager reads and pauses, and never manages, publishes or pauses a whole offer", () => {
    expect(offerAccess("store_manager", "specific")).toEqual({
      canRead: true,
      canManage: false,
      canPublish: false,
      canPause: true,
      canPauseWhole: false,
      tenantWide: false,
    });
  });

  test("a role never widens a membership: an owner bound to specific stores has no whole pause", () => {
    const access = offerAccess("owner", "specific");
    expect(access.canManage).toBe(true);
    expect(access.canPauseWhole).toBe(false);
    expect(access.tenantWide).toBe(false);
  });

  test("any other role, or none, reads nothing", () => {
    for (const role of ["store_staff", "cashier", "", null, undefined]) {
      expect(offerAccess(role, "all")).toMatchObject({ canRead: false, canPause: false });
    }
  });
});

describe("offerActions by state and role", () => {
  const owner = offerAccess("owner", "all");
  const manager = offerAccess("store_manager", "specific");

  test("a draft with a saved draft: edit, preview and publish; nothing to pause, end or archive", () => {
    expect(offerActions(draftOffer(), owner)).toEqual({
      edit: true,
      preview: true,
      publish: true,
      pause: false,
      resume: false,
      end: false,
      archive: false,
    });
  });

  test("an active offer: pause, end and a next draft; no resume", () => {
    expect(offerActions(offer({ state: "active" }), owner)).toMatchObject({
      edit: true,
      pause: true,
      end: true,
      resume: false,
      archive: false,
      publish: false,
    });
  });

  test("a paused offer can be resumed, and a store pause on a live offer can be lifted", () => {
    expect(offerActions(offer({ state: "paused" }), owner).resume).toBe(true);
    const storePaused = offer({
      state: "active",
      pausedStores: [
        { storeId: STORE_A, pausedAt: "2026-11-12T11:00:00Z", pausedByUserId: "u", reason: "x" },
      ],
    });
    expect(offerActions(storePaused, owner).resume).toBe(true);
  });

  test("only an ended offer is archived; an archived one offers nothing", () => {
    expect(offerActions(offer({ state: "ended" }), owner)).toMatchObject({
      archive: true,
      end: false,
    });
    expect(offerActions(offer({ state: "archived" }), owner)).toEqual({
      edit: false,
      preview: false,
      publish: false,
      pause: false,
      resume: false,
      end: false,
      archive: false,
    });
  });

  test("acceptance 2: a role without offers.publish cannot publish; a store_manager can only pause", () => {
    const withDraft = draftOffer({ state: "active" });
    const actions = offerActions(withDraft, manager);
    expect(actions.publish).toBe(false);
    expect(actions.edit).toBe(false);
    expect(actions.end).toBe(false);
    expect(actions.resume).toBe(false);
    expect(actions.archive).toBe(false);
    expect(actions.pause).toBe(true);
  });
});

describe("buildPauseBody: a required reason, and the stores a pause names", () => {
  const owner = offerAccess("owner", "all");
  const manager = offerAccess("store_manager", "specific");

  test("a whole-offer pause by an owner sends the reason only, trimmed", () => {
    expect(buildPauseBody({ reason: "  recall  ", scope: "whole", storeIds: [] }, owner)).toEqual({
      ok: true,
      body: { reason: "recall" },
    });
  });

  test("the reason is required and at most 500 characters", () => {
    expect(buildPauseBody({ reason: "   ", scope: "whole", storeIds: [] }, owner)).toEqual({
      ok: false,
      errors: { reason: "offers.pause.error.reasonRequired" },
    });
    const long = "x".repeat(501);
    const result = buildPauseBody({ reason: long, scope: "whole", storeIds: [] }, owner);
    expect(result.ok).toBe(false);
    expect(
      buildPauseBody({ reason: "x".repeat(500), scope: "whole", storeIds: [] }, owner).ok,
    ).toBe(true);
  });

  test("a store_manager always names their stores, even if the draft says whole", () => {
    expect(buildPauseBody({ reason: "r", scope: "whole", storeIds: [] }, manager)).toEqual({
      ok: false,
      errors: { storeIds: "offers.pause.error.storesRequired" },
    });
    expect(buildPauseBody({ reason: "r", scope: "whole", storeIds: [STORE_A] }, manager)).toEqual({
      ok: true,
      body: { reason: "r", storeIds: [STORE_A] },
    });
  });
});

describe("pausableStores", () => {
  const roster = [
    { id: STORE_A, name: "A" },
    { id: STORE_B, name: "B" },
  ];

  test("an all-stores offer offers the caller's whole roster, minus stores already paused", () => {
    const paused = offer({
      pausedStores: [
        { storeId: STORE_B, pausedAt: "2026-11-12T11:00:00Z", pausedByUserId: "u", reason: "x" },
      ],
    });
    expect(pausableStores(offer(), roster).map((s) => s.id)).toEqual([STORE_A, STORE_B]);
    expect(pausableStores(paused, roster).map((s) => s.id)).toEqual([STORE_A]);
  });

  test("a store-scoped offer offers only the roster stores of its scope", () => {
    const scoped = offer({
      currentVersion: {
        ...(offer().currentVersion as NonNullable<ReturnType<typeof offer>["currentVersion"]>),
        definition: definition({ storeScope: { storeIds: [STORE_B] } }),
      },
    });
    expect(pausableStores(scoped, roster).map((s) => s.id)).toEqual([STORE_B]);
  });
});

describe("display helpers", () => {
  test("every derived state has a label; an unknown one is said so and badged as an error", () => {
    expect(offerStateKey("paused")).toBe("offers.state.paused");
    expect(offerStateKey("whatever")).toBe("offers.state.unknown");
    expect(offerStateBadgeClass("active")).toBe("badge badge--success");
    expect(offerStateBadgeClass("paused")).toBe("badge badge--warning");
    expect(offerStateBadgeClass("ended")).toBe("badge");
    expect(offerStateBadgeClass("whatever")).toBe("badge badge--danger");
  });

  test("a store-local schedule is shown as written, never converted", () => {
    expect(
      scheduleText({ timeBasis: "store_local", startsAt: "2026-11-20T09:00:00", endsAt: null }),
    ).toEqual({
      start: "2026-11-20 09:00",
      end: null,
      storeLocal: true,
    });
  });

  test("a keyset walk keeps each offer once, where it first appeared", () => {
    expect(dedupeById([{ offerId: "a" }, { offerId: "b" }, { offerId: "a" }])).toEqual([
      { offerId: "a" },
      { offerId: "b" },
    ]);
  });
});

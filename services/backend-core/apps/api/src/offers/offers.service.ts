/**
 * OffersService — the Console runtime of the Offer Engine (spec 048; contract
 * `offers.openapi.yaml`; Jira RT-1337, RT-286 S4): authoring (draft create and
 * edit), validate and preview, publish, pause, resume, end, archive, and the
 * reads.
 *
 * Every operation runs in ONE transaction under the caller's tenant
 * (`runWithTenantContext` on the NOBYPASSRLS domain pool): RLS bounds each
 * statement to the tenant, which comes from the session, never the request
 * (§II, §XII). Every write that changes what tills apply (publish, pause,
 * resume, end, archive) takes the tenant's advisory lock first, so two such
 * writes serialise, and ends by `rebuildOfferPack`, which issues the new Pack
 * revision in the same transaction. The audit row of a write is written in the
 * same transaction (`offer-audit.ts`).
 *
 * Capabilities (OD-12) come from `offer-capabilities.ts`; the guards of the
 * controller already refuse other roles, and the service re-checks the
 * capability so it holds whichever route reaches it.
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import { PG_POOL } from "../auth/auth.module";
import { decodeOpaque, encodeOpaque } from "../common/cursor/opaque-cursor";
import { MembershipRepository } from "../context/membership.repository";
import { callerStoreScope, inStoreScope } from "../context/operator-store-scope";
import type { StoreScope } from "../context/store-scope";
import type { ResolvedContext } from "../context/types";
import { canRead, holdsCapability, isStoreBounded, type OfferCapability } from "./offer-capabilities";
import { insertOfferAudit } from "./offer-audit";
import { eligibleProductIds, ruleSetsOf, sampleProducts } from "./offer-eligibility";
import { OfferRefusedError } from "./offer-errors";
import {
  loadLiveOffers,
  loadTenantOffers,
  planPack,
  scopeStores,
  stateOf,
  type LoadedTenantOffers,
  type PackPlan,
} from "./offer-live";
import { rebuildOfferPack } from "./offer-pack.rebuild";
import {
  isVisible,
  toOfferBody,
  toSummary,
  toVersionBody,
  viewerOf,
  type Viewer,
} from "./offer-projections";
import { simulateOffer } from "./offer-simulation";
import { STORE_OFFER_LIMIT, ISSUE_ORDER, checkDefinition, findConflicts, type DefinitionCheck } from "./offer-validation";
import {
  OFFER_PAGE_SIZE_DEFAULT,
  normaliseDefinition,
  type OfferDefinition,
  type OfferCreateBody,
  type OfferListQuery,
  type OfferPauseBody,
  type OfferPreviewBody,
  type OfferPublishBody,
  type OfferResumeBody,
  type OfferUpdateBody,
  type OfferVersionListQuery,
} from "./offers.dto";
import {
  clearDraft,
  dbNow,
  insertOffer,
  insertPause,
  insertVersion,
  liveStoreIdsOf,
  loadLiveStores,
  loadOfferHeader,
  loadOfferHeaders,
  loadOpenPauses,
  loadVersions,
  lockTenantOffers,
  markArchived,
  markEnded,
  nextVersionNumber,
  resumePauses,
  writeDraft,
  type OfferHeader,
  type OpenPause,
} from "./offers.repository";

/** The session of a Console call. */
export interface OfferCallInput {
  readonly tenantId: string;
  readonly context: ResolvedContext;
  readonly actorUserId: string;
  readonly requestId: string | null;
}

const ListCursorSchema = z.object({ t: z.string().uuid(), c: z.string().min(1).max(40), i: z.string().uuid() }).strict();
const VersionCursorSchema = z.object({ t: z.string().uuid(), o: z.string().uuid(), v: z.number().int().min(1) }).strict();
const invalidCursor = (): Error => new OfferRefusedError("validation_error");

/** An offer row locked for a write, with the state it was read in. */
interface Locked {
  readonly header: OfferHeader;
  readonly loaded: LoadedTenantOffers;
}

interface Caller {
  readonly roleCode: string | null;
  readonly scope: StoreScope;
  readonly viewer: Viewer;
}

@Injectable()
export class OffersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  // ---------------------------------------------------------------- reads

  async list(input: OfferCallInput, query: OfferListQuery) {
    return this.inTenant(input.tenantId, async (client) => {
      const caller = await this.caller(client, input);
      this.requireRead(caller);
      const limit = query.page_size ?? OFFER_PAGE_SIZE_DEFAULT;
      if (query.store_id !== undefined) await this.requireStoreVisible(client, input, caller, query.store_id);
      const keyset =
        query.cursor === undefined
          ? null
          : (() => {
              const c = decodeOpaque(query.cursor, ListCursorSchema, invalidCursor);
              if (c.t !== input.tenantId.toLowerCase()) throw invalidCursor();
              return c;
            })();
      const now = await dbNow(client);
      const loaded = await loadTenantOffers(client, input.tenantId, now);
      const all = await loadOfferHeaders(client, input.tenantId);
      const matching = all.filter((h) => {
        const record = loaded.versions.get(h.id);
        if (!isVisible(h, record, caller.viewer)) return false;
        if (query.state !== undefined && stateOf(loaded, h) !== query.state) return false;
        if (query.store_id !== undefined) {
          const def = (record?.definition ?? h.draft?.definition)!;
          if ("storeIds" in def.storeScope && !def.storeScope.storeIds.includes(query.store_id)) return false;
        }
        return keyset === null || h.createdAtKey < keyset.c || (h.createdAtKey === keyset.c && h.id < keyset.i);
      });
      const page = matching.slice(0, limit);
      const plan = await this.conflictPlan(client, input.tenantId, loaded);
      const last = page.at(-1);
      return {
        items: page.map((header) => toSummary({ loaded, header, viewer: caller.viewer, plan })),
        nextCursor:
          matching.length > limit && last !== undefined
            ? encodeOpaque({ t: input.tenantId.toLowerCase(), c: last.createdAtKey, i: last.id })
            : null,
      };
    });
  }

  async get(input: OfferCallInput, offerId: string) {
    return this.inTenant(input.tenantId, async (client) => {
      const caller = await this.caller(client, input);
      this.requireRead(caller);
      return this.bodyOf(client, input, caller, offerId);
    });
  }

  async versions(input: OfferCallInput, offerId: string, query: OfferVersionListQuery) {
    return this.inTenant(input.tenantId, async (client) => {
      const caller = await this.caller(client, input);
      this.requireRead(caller);
      const limit = query.page_size ?? OFFER_PAGE_SIZE_DEFAULT;
      const keyset =
        query.cursor === undefined
          ? null
          : (() => {
              const c = decodeOpaque(query.cursor, VersionCursorSchema, invalidCursor);
              if (c.t !== input.tenantId.toLowerCase() || c.o !== offerId) throw invalidCursor();
              return c.v;
            })();
      const header = await loadOfferHeader(client, input.tenantId, offerId);
      if (header === null) throw new OfferRefusedError("offer_not_found");
      const current = (await loadVersions(client, input.tenantId, [offerId], { currentOnly: true }))[0];
      if (!isVisible(header, current, caller.viewer)) throw new OfferRefusedError("offer_not_found");
      const all = await loadVersions(client, input.tenantId, [offerId], { currentOnly: false });
      const visible = all.flatMap((r) => {
        const body = toVersionBody(r, caller.viewer);
        return body === null ? [] : [body];
      });
      const after = keyset === null ? visible : visible.filter((v) => v.version < keyset);
      const page = after.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page,
        nextCursor:
          after.length > limit && last !== undefined
            ? encodeOpaque({ t: input.tenantId.toLowerCase(), o: offerId, v: last.version })
            : null,
      };
    });
  }

  // --------------------------------------------------------------- drafts

  async createDraft(input: OfferCallInput, body: OfferCreateBody) {
    return this.inTenant(input.tenantId, async (client) => {
      const caller = await this.caller(client, input);
      this.require(caller, "offers.manage");
      const definition = normaliseDefinition(body.definition);
      this.requireConfined(caller, [definition]);
      const offerId = await insertOffer(client, { tenantId: input.tenantId, definition, userId: input.actorUserId });
      await insertOfferAudit(client, {
        ...input,
        action: "offer.draft_created",
        offerId,
        metadata: { draft_revision: 1 },
      });
      return this.bodyOf(client, input, caller, offerId);
    });
  }

  async updateDraft(input: OfferCallInput, offerId: string, body: OfferUpdateBody) {
    return this.inTenant(input.tenantId, async (client) => {
      const caller = await this.caller(client, input);
      this.require(caller, "offers.manage");
      const header = await loadOfferHeader(client, input.tenantId, offerId, { forUpdate: true });
      if (header === null) throw new OfferRefusedError("offer_not_found");
      const loaded = await this.loadOne(client, input.tenantId, header);
      this.requireConfinedOffer(caller, { header, loaded }, [normaliseDefinition(body.definition)]);
      const state = stateOf(loaded, header);
      if (state === "ended" || state === "archived") throw new OfferRefusedError("offer_state_invalid");
      const expected = header.draft === null ? null : header.draftRevision;
      if (body.expectedDraftRevision !== expected) throw new OfferRefusedError("offer_draft_changed_concurrently");
      const next = header.draftRevision + 1;
      await writeDraft(client, {
        tenantId: input.tenantId,
        offerId,
        definition: normaliseDefinition(body.definition),
        userId: input.actorUserId,
        nextRevision: next,
      });
      await insertOfferAudit(client, { ...input, action: "offer.draft_updated", offerId, metadata: { draft_revision: next } });
      return this.bodyOf(client, input, caller, offerId);
    });
  }

  async preview(input: OfferCallInput, offerId: string, body: OfferPreviewBody) {
    return this.inTenant(input.tenantId, async (client) => {
      const caller = await this.caller(client, input);
      this.require(caller, "offers.manage");
      const header = await loadOfferHeader(client, input.tenantId, offerId);
      if (header === null) throw new OfferRefusedError("offer_not_found");
      this.requireConfinedOffer(caller, { header, loaded: await this.loadOne(client, input.tenantId, header) }, []);
      if (header.draft === null) throw new OfferRefusedError("offer_state_invalid");
      if (body.expectedDraftRevision !== undefined && body.expectedDraftRevision !== header.draftRevision) {
        throw new OfferRefusedError("offer_draft_changed_concurrently");
      }
      const definition = header.draft.definition;
      const { check } = await this.check(client, input.tenantId, offerId, definition);
      const eligible = check.eligible.slice(0, 20_000);
      return {
        offerId,
        draftRevision: header.draftRevision,
        publishable: check.issues.length === 0 && check.conflicts.length === 0,
        issues: check.issues.slice(0, 100).map((i) => ({ code: i.code, field: i.field, message: i.message })),
        eligibleSet: {
          count: check.eligible.length > 20_000 ? 20_000 : check.eligible.length,
          sample: await sampleProducts(client, input.tenantId, eligible),
        },
        conflicts: check.conflicts,
        simulation:
          body.simulation === undefined
            ? null
            : simulateOffer(
                body.simulation,
                {
                  buyQuantity: definition.parameters.buyQuantity,
                  getQuantity: definition.parameters.getQuantity,
                  percentOff: definition.parameters.percentOff,
                  maxApplicationsPerSale: definition.parameters.maxApplicationsPerSale,
                },
                new Set(eligible),
              ),
      };
    });
  }

  // ------------------------------------------------------------ lifecycle

  async publish(input: OfferCallInput, offerId: string, body: OfferPublishBody) {
    return this.writeOffer(input, offerId, "offers.publish", async ({ client, caller, header, loaded }) => {
      const state = stateOf(loaded, header);
      if (state === "ended" || state === "archived") throw new OfferRefusedError("offer_state_invalid");
      if (header.draft === null || header.draftRevision !== body.expectedDraftRevision) {
        throw new OfferRefusedError("offer_draft_changed_concurrently");
      }
      const { check } = await this.check(client, input.tenantId, offerId, header.draft.definition);
      const first = ISSUE_ORDER.find((code) => check.issues.some((i) => i.code === code));
      if (first !== undefined) throw new OfferRefusedError(first);
      if (check.conflicts.length > 0) throw new OfferRefusedError("offer_conflict", check.conflicts);

      const version = await nextVersionNumber(client, input.tenantId, offerId);
      await insertVersion(client, {
        tenantId: input.tenantId,
        offerId,
        version,
        definition: header.draft.definition,
        eligibleSetCount: check.eligible.length,
        userId: input.actorUserId,
      });
      await clearDraft(client, input.tenantId, offerId);
      const pack = await rebuildOfferPack(client, input.tenantId);
      await insertOfferAudit(client, {
        ...input,
        action: "offer.published",
        offerId,
        metadata: { version, draft_revision: body.expectedDraftRevision, eligible_set_count: check.eligible.length, pack_revision: pack.revision },
      });
      return this.bodyOf(client, input, caller, offerId);
    });
  }

  async pause(input: OfferCallInput, offerId: string, body: OfferPauseBody) {
    return this.writeOffer(input, offerId, "offers.pause", async ({ client, caller, header, loaded }) => {
      // Visibility first: a hidden offer answers 404 whatever the role is allowed to ask (non-disclosing).
      if (!isVisible(header, loaded.versions.get(offerId), caller.viewer)) throw new OfferRefusedError("offer_not_found");
      // A caller bounded to their stores (a store_manager, or any role with a specific-stores membership) pauses
      // their own stores only, never the whole offer.
      if (caller.viewer.ownStoreIds !== null && body.storeIds === undefined) throw new OfferRefusedError("forbidden");
      const changed =
        body.storeIds === undefined
          ? await this.pauseWhole(client, input, { header, loaded }, body.reason)
          : await this.pauseStores(client, input, caller, { header, loaded }, { reason: body.reason, storeIds: body.storeIds });
      if (changed) {
        const pack = await rebuildOfferPack(client, input.tenantId);
        await insertOfferAudit(client, {
          ...input,
          action: "offer.paused",
          offerId,
          metadata: { reason: body.reason, store_ids: body.storeIds ?? null, pack_revision: pack.revision },
        });
      }
      return this.bodyOf(client, input, caller, offerId);
    });
  }

  /** A whole-offer pause: already paused is a no-op (false); only a scheduled or active offer can be paused. */
  private async pauseWhole(client: PoolClient, input: OfferCallInput, at: Locked, reason: string): Promise<boolean> {
    const state = stateOf(at.loaded, at.header);
    if (state === "paused") return false;
    if (state !== "scheduled" && state !== "active") throw new OfferRefusedError("offer_state_invalid");
    await insertPause(client, { tenantId: input.tenantId, offerId: at.header.id, storeId: null, reason, userId: input.actorUserId });
    return true;
  }

  /** Store pauses (also on a paused offer): stores already paused are skipped; nothing new is a no-op (false). */
  private async pauseStores(
    client: PoolClient,
    input: OfferCallInput,
    caller: Caller,
    at: Locked,
    pause: { readonly reason: string; readonly storeIds: ReadonlyArray<string> },
  ): Promise<boolean> {
    await this.requireStoresVisible(client, input, caller, pause.storeIds);
    const state = stateOf(at.loaded, at.header);
    if (state !== "scheduled" && state !== "active" && state !== "paused") throw new OfferRefusedError("offer_state_invalid");
    const inScope = new Set(scopeStores(at.loaded.versions.get(at.header.id)!, at.loaded.stores).map((s) => s.id));
    if (pause.storeIds.some((s) => !inScope.has(s))) throw new OfferRefusedError("offer_store_not_in_scope");
    const already = new Set(at.loaded.pauses.filter((p) => p.offerId === at.header.id && p.storeId !== null).map((p) => p.storeId!));
    const fresh = pause.storeIds.filter((s) => !already.has(s));
    // sequential: the inserts share one PoolClient (pg runs its queries one at a time).
    for (const storeId of fresh) {
      await insertPause(client, { tenantId: input.tenantId, offerId: at.header.id, storeId, reason: pause.reason, userId: input.actorUserId });
    }
    return fresh.length > 0;
  }

  async resume(input: OfferCallInput, offerId: string, body: OfferResumeBody) {
    return this.writeOffer(input, offerId, "offers.publish", async ({ client, caller, header, loaded }) => {
      const record = loaded.versions.get(offerId);
      const open = loaded.pauses.filter((p) => p.offerId === offerId);
      const stateNow = stateOf(loaded, header);
      // Nothing paused, or an ended or archived offer (its pause row may still be open): it cannot be resumed.
      if (open.length === 0 || record === undefined || stateNow === "ended" || stateNow === "archived") {
        throw new OfferRefusedError("offer_state_invalid");
      }
      const lifting = await this.pausesToLift(client, input.tenantId, open, body.storeIds);
      await this.assertResumable(client, input.tenantId, { header, loaded }, lifting);
      await resumePauses(client, { tenantId: input.tenantId, pauseIds: lifting.map((p) => p.id), userId: input.actorUserId });
      const pack = await rebuildOfferPack(client, input.tenantId);
      await insertOfferAudit(client, {
        ...input,
        action: "offer.resumed",
        offerId,
        metadata: { store_ids: body.storeIds ?? null, pack_revision: pack.revision },
      });
      return this.bodyOf(client, input, caller, offerId);
    });
  }

  /** Every open pause, or only the named stores' (each must be a store of the tenant and paused). */
  private async pausesToLift(
    client: PoolClient,
    tenantId: string,
    open: ReadonlyArray<OpenPause>,
    storeIds: ReadonlyArray<string> | undefined,
  ): Promise<ReadonlyArray<OpenPause>> {
    if (storeIds === undefined) return open;
    const live = await liveStoreIdsOf(client, tenantId, storeIds);
    if (storeIds.some((s) => !live.has(s))) throw new OfferRefusedError("store_not_found");
    const paused = new Set(open.filter((p) => p.storeId !== null).map((p) => p.storeId!));
    if (storeIds.some((s) => !paused.has(s))) throw new OfferRefusedError("offer_store_not_in_scope");
    return open.filter((p) => p.storeId !== null && storeIds.includes(p.storeId));
  }

  /** Re-check what a resume would put back into the Pack (OD-7 conflicts, the store limit). */
  private async assertResumable(
    client: PoolClient,
    tenantId: string,
    at: Locked,
    lifting: ReadonlyArray<OpenPause>,
  ): Promise<void> {
    const record = at.loaded.versions.get(at.header.id)!;
    const full = await loadTenantOffers(client, tenantId, at.loaded.now);
    const others = await loadLiveOffers(client, tenantId, full, { excludeOfferId: at.header.id });
    const eligible = await eligibleProductIds(client, tenantId, ruleSetsOf(record.definition));
    const scoped = scopeStores(record, at.loaded.stores).map((s) => s.id);
    const back = lifting.some((p) => p.storeId === null) ? scoped : scoped.filter((s) => lifting.some((p) => p.storeId === s));
    const counts = new Map<string, number>();
    for (const o of others) for (const s of o.holdingStores) counts.set(s, (counts.get(s) ?? 0) + 1);
    if (back.some((s) => (counts.get(s) ?? 0) + 1 > STORE_OFFER_LIMIT)) throw new OfferRefusedError("offer_store_offer_limit_exceeded");
    const conflicts = await findConflicts(client, tenantId, full, others, { eligible, stores: new Set(back) });
    if (conflicts.length > 0) throw new OfferRefusedError("offer_conflict", conflicts);
  }

  async end(input: OfferCallInput, offerId: string) {
    return this.writeOffer(input, offerId, "offers.manage", async ({ client, caller, header, loaded }) => {
      const state = stateOf(loaded, header);
      if (state === "ended") return this.bodyOf(client, input, caller, offerId);
      if (state !== "scheduled" && state !== "active" && state !== "paused") throw new OfferRefusedError("offer_state_invalid");
      await markEnded(client, input.tenantId, offerId, input.actorUserId);
      const pack = await rebuildOfferPack(client, input.tenantId);
      await insertOfferAudit(client, { ...input, action: "offer.ended", offerId, metadata: { pack_revision: pack.revision } });
      return this.bodyOf(client, input, caller, offerId);
    });
  }

  async archive(input: OfferCallInput, offerId: string) {
    return this.writeOffer(input, offerId, "offers.manage", async ({ client, caller, header, loaded }) => {
      const state = stateOf(loaded, header);
      if (state === "archived") return this.bodyOf(client, input, caller, offerId);
      if (state !== "ended") throw new OfferRefusedError("offer_state_invalid");
      await markArchived(client, input.tenantId, offerId, input.actorUserId);
      // An offer whose window closed by itself may still hold rows: sweep them now.
      const pack = await rebuildOfferPack(client, input.tenantId);
      await insertOfferAudit(client, { ...input, action: "offer.archived", offerId, metadata: { pack_revision: pack.revision } });
      return this.bodyOf(client, input, caller, offerId);
    });
  }

  // -------------------------------------------------------------- helpers

  private inTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const scope = { tenantId, isPlatformAdmin: false };
    return runWithTenantContext(this.pool, scope, work);
  }

  /**
   * One Pack-affecting write: the capability check, the tenant's advisory lock,
   * the offer row locked and its state, then `work`, all in ONE transaction.
   */
  private writeOffer<T>(
    input: OfferCallInput,
    offerId: string,
    capability: OfferCapability,
    work: (at: Locked & { readonly client: PoolClient; readonly caller: Caller }) => Promise<T>,
  ): Promise<T> {
    return this.inTenant(input.tenantId, async (client) => {
      const caller = await this.caller(client, input);
      this.require(caller, capability);
      const locked = await this.lockedOffer(client, input, offerId);
      // Pause answers for itself (visibility, then own stores only); every other write needs the whole offer in scope.
      if (capability !== "offers.pause") this.requireConfinedOffer(caller, locked, []);
      return work({ client, caller, ...locked });
    });
  }

  private async caller(client: PoolClient, input: OfferCallInput): Promise<Caller> {
    const scope = await callerStoreScope(client, this.memberships, { tenantId: input.tenantId, context: input.context });
    const roleCode = await this.memberships.findRoleCodeForUserInTenant(input.actorUserId, input.tenantId, client);
    return { roleCode, scope, viewer: viewerOf(scope, isStoreBounded(roleCode)) };
  }

  /**
   * A role with `offers.manage` or `offers.publish` but a specific-stores membership may act only on offers whose
   * every store is one of theirs, never on an all-stores offer (RT-131: a role never widens a membership). A
   * tenant-wide caller is not limited; a store_manager holds neither capability.
   */
  private requireConfined(caller: Caller, definitions: ReadonlyArray<OfferDefinition | undefined>): void {
    const own = caller.viewer.ownStoreIds;
    if (own === null) return;
    for (const d of definitions) {
      if (d === undefined) continue;
      if ("allStores" in d.storeScope || d.storeScope.storeIds.some((s) => !own.has(s.toLowerCase()))) throw new OfferRefusedError("forbidden");
    }
  }

  /** The offer must be visible (else the non-disclosing 404), and its draft and current version must be confined. */
  private requireConfinedOffer(caller: Caller, at: Locked, extra: ReadonlyArray<OfferDefinition>): void {
    if (caller.viewer.ownStoreIds === null) return;
    if (!isVisible(at.header, at.loaded.versions.get(at.header.id), caller.viewer)) throw new OfferRefusedError("offer_not_found");
    this.requireConfined(caller, [at.header.draft?.definition, at.loaded.versions.get(at.header.id)?.definition, ...extra]);
  }

  private requireRead(caller: Caller): void {
    if (!canRead(caller.roleCode)) throw new OfferRefusedError("forbidden");
  }

  private require(caller: Caller, capability: OfferCapability): void {
    if (!holdsCapability(caller.roleCode, capability)) throw new OfferRefusedError("forbidden");
  }

  /** A store that is not a live store of the tenant, or outside a bounded caller's scope, is the same 404. */
  private async requireStoreVisible(client: PoolClient, input: OfferCallInput, caller: Caller, storeId: string): Promise<void> {
    await this.requireStoresVisible(client, input, caller, [storeId]);
  }

  private async requireStoresVisible(
    client: PoolClient,
    input: OfferCallInput,
    caller: Caller,
    storeIds: ReadonlyArray<string>,
  ): Promise<void> {
    if (storeIds.some((s) => caller.viewer.ownStoreIds !== null && !inStoreScope(caller.scope, s))) {
      throw new OfferRefusedError("store_not_found");
    }
    const live = await liveStoreIdsOf(client, input.tenantId, storeIds);
    if (storeIds.some((s) => !live.has(s))) throw new OfferRefusedError("store_not_found");
  }

  /**
   * A Pack-affecting write starts here: the tenant's advisory lock first (so
   * two such writes serialise), then the offer row locked, then its state.
   */
  private async lockedOffer(client: PoolClient, input: OfferCallInput, offerId: string): Promise<Locked> {
    await lockTenantOffers(client, input.tenantId);
    const header = await loadOfferHeader(client, input.tenantId, offerId, { forUpdate: true });
    if (header === null) throw new OfferRefusedError("offer_not_found");
    return { header, loaded: await this.loadOne(client, input.tenantId, header) };
  }

  /** Just this offer, with the tenant's live stores: enough for its derived state and body. */
  private async loadOne(client: PoolClient, tenantId: string, header: OfferHeader): Promise<LoadedTenantOffers> {
    // sequential: the reads share one PoolClient (pg runs its queries one at a time).
    const now = await dbNow(client);
    const stores = await loadLiveStores(client, tenantId);
    const versions = await loadVersions(client, tenantId, [header.id], { currentOnly: true });
    const pauses = await loadOpenPauses(client, tenantId, [header.id]);
    return { now, stores, headers: [header], versions: new Map(versions.map((v) => [v.offerId, v])), pauses };
  }

  /** The Console `Offer` body of one offer, 404 when absent or hidden from the caller. */
  private async bodyOf(client: PoolClient, input: OfferCallInput, caller: Caller, offerId: string) {
    const header = await loadOfferHeader(client, input.tenantId, offerId);
    if (header === null) throw new OfferRefusedError("offer_not_found");
    const full = await loadTenantOffers(client, input.tenantId, await dbNow(client));
    if (!isVisible(header, full.versions.get(offerId), caller.viewer)) throw new OfferRefusedError("offer_not_found");
    const plan = await this.conflictPlan(client, input.tenantId, full);
    const names = {
      nameOf: (id: string): string => full.versions.get(id)?.definition.nameAr ?? full.headers.find((h) => h.id === id)?.draft?.definition.nameAr ?? "",
    };
    return toOfferBody({ loaded: full, header, viewer: caller.viewer, plan, names });
  }

  /**
   * The re-materialisation conflicts (OD-7 clarification) need every live
   * offer's eligible set, so they are computed only when at least two offers
   * are live (one offer cannot conflict with itself).
   */
  private async conflictPlan(client: PoolClient, tenantId: string, loaded: LoadedTenantOffers): Promise<PackPlan | null> {
    const candidates = loaded.headers.filter((h) => h.archivedAt === null && h.endedAt === null && loaded.versions.has(h.id));
    if (candidates.length < 2) return null;
    return planPack(await loadLiveOffers(client, tenantId, loaded));
  }

  /** The checks of a definition against the live offers other than `offerId` itself (a publish replaces its own). */
  private async check(
    client: PoolClient,
    tenantId: string,
    offerId: string,
    definition: Parameters<typeof checkDefinition>[4],
  ): Promise<{ check: DefinitionCheck }> {
    const full = await loadTenantOffers(client, tenantId, await dbNow(client));
    const others = await loadLiveOffers(client, tenantId, full, { excludeOfferId: offerId });
    return { check: await checkDefinition(client, tenantId, full, others, definition) };
  }
}

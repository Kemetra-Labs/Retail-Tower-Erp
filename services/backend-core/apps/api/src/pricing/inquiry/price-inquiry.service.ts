/**
 * PriceInquiryService — RT-1484 (RT-282 PR-08b): the runtime of `pricing/price-inquiry.yaml`
 * 1.0.0-draft (spec 041 §4, §8): the price of a product in a Store at an instant, its timeline,
 * and "why this price", each as known at a Pricing Revision.
 *
 * One read-only transaction per request under `runWithTenantContext` (tenant RLS, FORCE,
 * `isPlatformAdmin: false`); the tenant is the session's (§II, §XII). In order:
 *   1. the Store must be live, of the tenant and inside the caller's store scope (a store_manager
 *      reads only its `store_access` Stores), and the product must be the tenant's — otherwise the
 *      one non-disclosing 404;
 *   2. the revision: an explicit `as_of_revision` above the head is 422
 *      `pricing_revision_unknown`; without one, the head (null before the first publish);
 *   3. the Pricing data visible at that revision (`price-inquiry.repository.ts`), resolved by the
 *      pure resolver (`../resolution`). Nothing reads the legacy catalogue price.
 *
 * Instants are written in the Store's time zone (as the resolver writes provenance).
 */
import { Inject, Injectable } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool, PoolClient } from "pg";

import { isTenantProduct } from "../../catalog";
import { callerStoreScope, MembershipRepository, scopeStoreIds, type TenantContextRequest } from "../../context";
import { PG_POOL } from "../../database";
import { liveStoreTimezone } from "../../stores";
import { pricingRevisionAt } from "../pricing-revision";
import { traceResolution } from "../resolution/resolve";
import { formatInstantInZone } from "../resolution/store-local-time";
import { nextChange, resolveTimeline } from "../resolution/timeline";
import type { ResolutionStore } from "../resolution/types";
import type { PriceInquiryQuery, PriceTimelineQuery } from "./price-inquiry.dto";
import {
  explainLayers,
  PriceInquiryNotFoundError,
  type PriceExplanationBody,
  type PriceInquiryBody,
  type PriceTimelineBody,
} from "./price-inquiry.projections";
import { loadResolutionData, type LoadedResolutionData } from "./price-inquiry.repository";

/** The session tenant and context of a read. */
export interface InquiryReadInput {
  readonly tenantId: string;
  readonly context: NonNullable<TenantContextRequest["context"]>;
}

/** The price key of a request: the Store and product path ids (lower case). */
export interface InquiryTarget {
  readonly storeId: string;
  readonly productId: string;
}

const SELL_UNIT = "each";

/** What every inquiry resolves against. */
interface Resolvable {
  readonly store: ResolutionStore;
  readonly revision: number | null;
  /** The resolver's revision: the requested one, or 0 (nothing visible) before the first publish. */
  readonly resolverRevision: number;
  readonly data: LoadedResolutionData;
}

@Injectable()
export class PriceInquiryService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(MembershipRepository) private readonly memberships: MembershipRepository,
  ) {}

  /** consoleGetStoreProductPrice — the resolution at `at` (default: now). */
  price(input: InquiryReadInput, target: InquiryTarget, query: PriceInquiryQuery): Promise<PriceInquiryBody> {
    const instant = instantOf(query.at);
    return this.inTenant(input, async (client) => {
      const r = await this.resolvable(client, input, target, query.as_of_revision);
      const trace = traceResolution(target.productId, SELL_UNIT, r.store, instant, r.resolverRevision, r.data);
      return { ...this.head(target, r), evaluatedAt: formatInstantInZone(instant, r.store.timezone), result: trace.result };
    });
  }

  /** consoleGetStoreProductPriceTimeline — contiguous segments over `[from, to)`. */
  timeline(input: InquiryReadInput, target: InquiryTarget, query: PriceTimelineQuery): Promise<PriceTimelineBody> {
    const from = instantOf(query.from);
    const to = instantOf(query.to);
    return this.inTenant(input, async (client) => {
      const r = await this.resolvable(client, input, target, query.as_of_revision);
      const zone = r.store.timezone;
      const segments = resolveTimeline(
        target.productId,
        SELL_UNIT,
        r.store,
        from.getTime(),
        to.getTime(),
        r.resolverRevision,
        r.data,
      ).map((s) => ({
        from: formatInstantInZone(new Date(s.fromMs), zone),
        to: formatInstantInZone(new Date(s.toMs), zone),
        result: s.result,
      }));
      return {
        ...this.head(target, r),
        from: formatInstantInZone(from, zone),
        to: formatInstantInZone(to, zone),
        segments,
      };
    });
  }

  /** consoleExplainStoreProductPrice — the resolution, its three layers and the next published change. */
  explain(input: InquiryReadInput, target: InquiryTarget, query: PriceInquiryQuery): Promise<PriceExplanationBody> {
    const instant = instantOf(query.at);
    return this.inTenant(input, async (client) => {
      const r = await this.resolvable(client, input, target, query.as_of_revision);
      const zone = r.store.timezone;
      const trace = traceResolution(target.productId, SELL_UNIT, r.store, instant, r.resolverRevision, r.data);
      const changeSetOf = (eventId: string): string => {
        const id = r.data.changeSetOf.get(eventId);
        if (id === undefined) throw new Error(`price event ${eventId} was not loaded`);
        return id;
      };
      const next = nextChange(target.productId, SELL_UNIT, r.store, instant, r.resolverRevision, r.data);
      return {
        ...this.head(target, r),
        evaluatedAt: formatInstantInZone(instant, zone),
        result: trace.result,
        layers: explainLayers(trace, zone, changeSetOf),
        next: next === null ? null : { at: formatInstantInZone(next.at, zone), result: next.result },
      };
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Steps 1-3 of the class comment: scope and existence (404), the revision (422), the data. */
  private async resolvable(
    client: PoolClient,
    input: InquiryReadInput,
    target: InquiryTarget,
    requestedRevision: number | undefined,
  ): Promise<Resolvable> {
    const scoped = scopeStoreIds(await callerStoreScope(client, this.memberships, input));
    if (scoped !== null && !scoped.includes(target.storeId)) throw new PriceInquiryNotFoundError();
    const timezone = await liveStoreTimezone(client, input.tenantId, target.storeId);
    if (timezone === null || !(await isTenantProduct(client, input.tenantId, target.productId))) {
      throw new PriceInquiryNotFoundError();
    }
    const revision = await pricingRevisionAt(client, input.tenantId, requestedRevision);
    const data = await loadResolutionData(client, {
      tenantId: input.tenantId,
      storeId: target.storeId,
      productId: target.productId,
      sellUnit: SELL_UNIT,
      revision,
    });
    return {
      store: { id: target.storeId, tenantId: input.tenantId, timezone },
      revision,
      resolverRevision: revision ?? 0,
      data,
    };
  }

  private head(target: InquiryTarget, r: Resolvable) {
    return {
      storeId: target.storeId,
      productId: target.productId,
      sellUnit: SELL_UNIT,
      asOfRevision: r.revision,
      storeTimeZone: r.store.timezone,
    } as const;
  }

  /** One read-only transaction under the caller's tenant (RLS, FORCE). */
  private inTenant<T>(input: InquiryReadInput, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return runWithTenantContext(this.pool, { tenantId: input.tenantId, isPlatformAdmin: false }, fn);
  }
}

/** A validated RFC 3339 query instant, or the server's current time. */
function instantOf(value: string | undefined): Date {
  return value === undefined ? new Date() : new Date(Date.parse(value));
}

/**
 * PriceInquiryController — RT-1484 (RT-282 PR-08b): the read surface of
 * `pricing/price-inquiry.yaml` 1.0.0-draft.
 *
 *   GET /api/v1/pricing/stores/{storeId}/products/{productId}/price     consoleGetStoreProductPrice
 *   GET /api/v1/pricing/stores/{storeId}/products/{productId}/timeline  consoleGetStoreProductPriceTimeline
 *   GET /api/v1/pricing/stores/{storeId}/products/{productId}/explain   consoleExplainStoreProductPrice
 *
 * Auth: `SessionOnlyAdminGuard` (the human cookie session only; every bearer is 401), then
 * `TenantContextGuard`, then `RolesGuard` (`owner`, `tenant_admin`, `store_manager`; any other
 * role is the non-disclosing 404). A store_manager reads only its own Stores (the service). The
 * tenant is the session's (§XII). Every response is `Cache-Control: no-store`. A malformed path
 * id or query parameter is a 400 before any read.
 */
import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Query,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";

import { Roles, RolesGuard, SessionOnlyAdminGuard } from "../../auth";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../../console-rate-limit";
import { TenantContextGuard, type TenantContextRequest } from "../../context";
import { parsePathId, sessionReader } from "../pricing-query";
import { PricingRevisionUnknownError } from "../pricing-revision";
import {
  PriceInquiryQuerySchema,
  PriceTimelineQuerySchema,
  type PriceInquiryQuery,
  type PriceTimelineQuery,
} from "./price-inquiry.dto";
import {
  PriceInquiryNotFoundError,
  type PriceExplanationBody,
  type PriceInquiryBody,
  type PriceTimelineBody,
} from "./price-inquiry.projections";
import { PriceInquiryService, type InquiryTarget } from "./price-inquiry.service";

const PRODUCT = "api/v1/pricing/stores/:storeId/products/:productId";

/** The one 404 body of this surface, equal to the `RolesGuard` refusal (§II, §XII). */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard, RolesGuard)
@Roles("owner", "tenant_admin", "store_manager")
export class PriceInquiryController {
  constructor(private readonly service: PriceInquiryService) {}

  @Get(`${PRODUCT}/price`)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  price(
    @Req() request: TenantContextRequest,
    @Param("storeId") storeId: string,
    @Param("productId") productId: string,
    @Query(new ZodValidationPipe(PriceInquiryQuerySchema)) query: PriceInquiryQuery,
  ): Promise<PriceInquiryBody> {
    const target = targetOf(storeId, productId);
    return mapErrors(() => this.service.price(reader(request), target, query));
  }

  @Get(`${PRODUCT}/timeline`)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("expensiveRead")
  timeline(
    @Req() request: TenantContextRequest,
    @Param("storeId") storeId: string,
    @Param("productId") productId: string,
    @Query(new ZodValidationPipe(PriceTimelineQuerySchema)) query: PriceTimelineQuery,
  ): Promise<PriceTimelineBody> {
    const target = targetOf(storeId, productId);
    return mapErrors(() => this.service.timeline(reader(request), target, query));
  }

  @Get(`${PRODUCT}/explain`)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  explain(
    @Req() request: TenantContextRequest,
    @Param("storeId") storeId: string,
    @Param("productId") productId: string,
    @Query(new ZodValidationPipe(PriceInquiryQuerySchema)) query: PriceInquiryQuery,
  ): Promise<PriceExplanationBody> {
    const target = targetOf(storeId, productId);
    return mapErrors(() => this.service.explain(reader(request), target, query));
  }
}

/** Request-shape errors, checked before any read: they disclose nothing. */
function targetOf(storeId: string, productId: string): InquiryTarget {
  return { storeId: parsePathId(storeId, "storeId"), productId: parsePathId(productId, "productId") };
}

const reader = sessionReader;

/** Runs `work`, answering a service refusal with the contract's 4xx; anything else propagates (500). */
function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  return Promise.resolve()
    .then(work)
    .catch((err: unknown) => {
      if (err instanceof PriceInquiryNotFoundError) throw new NotFoundException(NOT_FOUND);
      if (err instanceof PricingRevisionUnknownError) {
        throw new UnprocessableEntityException({
          code: "pricing_revision_unknown",
          message: "The tenant has not published this Pricing Revision.",
        });
      }
      throw err;
    });
}

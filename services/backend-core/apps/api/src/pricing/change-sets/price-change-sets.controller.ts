/**
 * PriceChangeSetsController — RT-1484 (RT-282 PR-09b): the authoring surface of
 * `pricing/price-change-sets.yaml` 1.0.0-draft.
 *
 *   GET   /api/v1/pricing/change-sets                        consoleListPriceChangeSets
 *   POST  /api/v1/pricing/change-sets                        consoleCreatePriceChangeSet
 *   GET   /api/v1/pricing/change-sets/{changeSetId}          consoleGetPriceChangeSet
 *   PATCH /api/v1/pricing/change-sets/{changeSetId}          consoleUpdatePriceChangeSet
 *   POST  /api/v1/pricing/change-sets/{changeSetId}/cancel   consoleCancelPriceChangeSet
 *
 * Auth: `SessionOnlyAdminGuard` (the human cookie session only; every bearer is 401; a write
 * without a trusted `Origin` is 403 `origin_rejected`, RT-430), then `TenantContextGuard`, then
 * `RolesGuard`: `owner` / `tenant_admin` only, reads included; any other role (a Store Manager
 * too, Q-B2) is the non-disclosing 404. The tenant and the actor are the session's (§XII).
 *
 * Every write is `@Idempotent("required")` and writes its audit row in its own transaction (the
 * service), so no handler carries `@Auditable`. Every response is `Cache-Control: no-store`. A
 * malformed path id is a 400 before any read.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";

// Guards, in the order the controller applies them, then the per-route decorators.
import { SessionOnlyAdminGuard, Roles, RolesGuard } from "../../auth";
import { TenantContextGuard, type TenantContextRequest } from "../../context";
import { ConsoleRateLimit } from "../../console-rate-limit";
import { Idempotent } from "../../idempotency";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { mapPricingErrors, parsePathId, sessionReader, sessionWriter } from "../pricing-query";
import {
  CreatePriceChangeSetBodySchema,
  ListChangeSetsQuerySchema,
  UpdatePriceChangeSetBodySchema,
  VersionedBodySchema,
  type CreatePriceChangeSetBody,
  type ListChangeSetsQuery,
  type UpdatePriceChangeSetBody,
  type VersionedBody,
} from "./price-change-sets.dto";
import {
  ChangeSetListCursorError,
  PriceChangeSetConflictError,
  PriceChangeSetNotFoundError,
  type PriceChangeSetBody,
  type PriceChangeSetConflictCode,
  type PriceChangeSetPageBody,
} from "./price-change-sets.projections";
import { PriceChangeSetsService, type ChangeSetWriteInput } from "./price-change-sets.service";

const CHANGE_SETS = "api/v1/pricing/change-sets";
const CHANGE_SET = `${CHANGE_SETS}/:changeSetId`;

/** The one 404 body of this surface, equal to the `RolesGuard` refusal (§II, §XII). */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

const CONFLICT_MESSAGES: Readonly<Record<PriceChangeSetConflictCode, string>> = {
  version_conflict: "The Change Set has changed; reload it and retry with its current version.",
  change_set_invalid_state: "The Change Set's state does not allow this call.",
  price_book_missing: "The tenant has no retail Price Book.",
  pricing_authority_legacy: "Price authoring is not enabled for this tenant.",
};

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard, RolesGuard)
@Roles("owner", "tenant_admin")
export class PriceChangeSetsController {
  constructor(private readonly service: PriceChangeSetsService) {}

  @Get(CHANGE_SETS)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  list(
    @Req() request: TenantContextRequest,
    @Query(new ZodValidationPipe(ListChangeSetsQuerySchema)) query: ListChangeSetsQuery,
  ): Promise<PriceChangeSetPageBody> {
    return mapErrors(() => this.service.list(sessionReader(request), query));
  }

  @Post(CHANGE_SETS)
  @HttpCode(201)
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("write")
  create(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(CreatePriceChangeSetBodySchema)) body: CreatePriceChangeSetBody,
  ): Promise<PriceChangeSetBody> {
    return mapErrors(() => this.service.create(writer(request), body));
  }

  @Get(CHANGE_SET)
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  get(@Req() request: TenantContextRequest, @Param("changeSetId") changeSetId: string): Promise<PriceChangeSetBody> {
    const id = parsePathId(changeSetId, "changeSetId");
    return mapErrors(() => this.service.get(sessionReader(request), id));
  }

  @Patch(CHANGE_SET)
  @HttpCode(200)
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("write")
  update(
    @Req() request: TenantContextRequest,
    @Param("changeSetId") changeSetId: string,
    @Body(new ZodValidationPipe(UpdatePriceChangeSetBodySchema)) body: UpdatePriceChangeSetBody,
  ): Promise<PriceChangeSetBody> {
    const id = parsePathId(changeSetId, "changeSetId");
    return mapErrors(() => this.service.update(writer(request), id, body));
  }

  @Post(`${CHANGE_SET}/cancel`)
  @HttpCode(200)
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("write")
  cancel(
    @Req() request: TenantContextRequest,
    @Param("changeSetId") changeSetId: string,
    @Body(new ZodValidationPipe(VersionedBodySchema)) body: VersionedBody,
  ): Promise<PriceChangeSetBody> {
    const id = parsePathId(changeSetId, "changeSetId");
    return mapErrors(() => this.service.cancel(writer(request), id, body));
  }
}

const writer: (request: TenantContextRequest) => ChangeSetWriteInput = sessionWriter;

/** Runs `work`, answering a service refusal with the contract's 4xx; anything else propagates (500). */
function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  return mapPricingErrors(work, httpErrorOf);
}

function httpErrorOf(err: unknown): unknown {
  if (err instanceof PriceChangeSetNotFoundError) return new NotFoundException(NOT_FOUND);
  if (err instanceof PriceChangeSetConflictError) {
    return new HttpException({ code: err.code, message: CONFLICT_MESSAGES[err.code] }, 409);
  }
  if (err instanceof ChangeSetListCursorError) return new BadRequestException({ code: "validation_error", message: err.message });
  return err;
}

/**
 * PriceStructureController — RT-1484 (RT-282 PR-09a): the Price Books, Zones and memberships
 * surface of `pricing/price-structure.yaml` 1.0.0-draft.
 *
 *   GET  /api/v1/pricing/books                                   consoleListPriceBooks
 *   POST /api/v1/pricing/books                                   consoleCreatePriceBook
 *   GET  /api/v1/pricing/books/{bookId}                          consoleGetPriceBook
 *   POST /api/v1/pricing/books/{bookId}/zones                    consoleCreatePriceZone
 *   POST /api/v1/pricing/books/{bookId}/zones/{zoneId}/retire    consoleRetirePriceZone
 *   GET  /api/v1/pricing/books/{bookId}/zones/{zoneId}/stores    consoleListPriceZoneStores
 *   GET  /api/v1/pricing/stores/{storeId}/zone-memberships       consoleListStorePriceZoneMemberships
 *
 * Auth: `SessionOnlyAdminGuard` (the human cookie session only; every bearer is 401; a write
 * without a trusted `Origin` is 403 `origin_rejected`, RT-430), then `TenantContextGuard`, then
 * `RolesGuard` (default deny → the non-disclosing 404). Writes: `owner` / `tenant_admin`. Reads:
 * also `store_manager`, whose membership reads are limited to its own Stores (the service). The
 * tenant and the actor are the session's (§XII).
 *
 * Every write is `@Idempotent("required")` (`x-idempotency: required`) and writes its audit row
 * in its own transaction (the service), so no handler carries `@Auditable`. Every response is
 * `Cache-Control: no-store`. A malformed path id is a 400 before any read.
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
  Post,
  Query,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
  UseGuards,
} from "@nestjs/common";

import { Roles, RolesGuard, SessionOnlyAdminGuard } from "../../auth";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../../console-rate-limit";
import { TenantContextGuard, type TenantContextRequest } from "../../context";
import { Idempotent } from "../../idempotency";
import {
  CreatePriceBookBodySchema,
  CreatePriceZoneBodySchema,
  PathIdSchema,
  RetirePriceZoneBodySchema,
  StoreMembershipsQuerySchema,
  ZoneStoresQuerySchema,
  type CreatePriceBookBody,
  type CreatePriceZoneBody,
  type RetirePriceZoneBody,
  type StoreMembershipsQuery,
  type ZoneStoresQuery,
} from "./price-structure.dto";
import {
  PriceStructureConflictError,
  PriceStructureNotFoundError,
  PricingRevisionUnknownError,
  ZoneStoresCursorError,
  type PriceBookBody,
  type PriceStructureConflictCode,
  type PriceZoneBody,
  type PriceZoneStorePageBody,
  type StorePriceZoneMembershipsBody,
} from "./price-structure.projections";
import { PriceStructureService, type StructureReadInput, type StructureWriteInput } from "./price-structure.service";

const BOOKS = "api/v1/pricing/books";
const BOOK = `${BOOKS}/:bookId`;
const ZONE = `${BOOK}/zones/:zoneId`;
const STORE_MEMBERSHIPS = "api/v1/pricing/stores/:storeId/zone-memberships";

/** The one 404 body of this surface, equal to the `RolesGuard` refusal (§II, §XII). */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

const CONFLICT_MESSAGES: Readonly<Record<PriceStructureConflictCode, string>> = {
  price_book_exists: "The tenant already has a retail Price Book.",
  price_book_code_taken: "A Price Book already uses this code.",
  price_book_retired: "The Price Book is retired.",
  price_zone_code_taken: "A Zone of this Price Book already uses this code.",
  default_price_zone_immutable: "The default Zone cannot be retired.",
  price_zone_in_use: "The Zone is in use.",
  price_zone_retired: "The Zone is already retired.",
};

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class PriceStructureController {
  constructor(private readonly service: PriceStructureService) {}

  @Get(BOOKS)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  listBooks(@Req() request: TenantContextRequest): Promise<{ items: PriceBookBody[] }> {
    return mapErrors(() => this.service.listBooks(reader(request)));
  }

  @Post(BOOKS)
  @HttpCode(201)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("write")
  createBook(
    @Req() request: TenantContextRequest,
    @Body(new ZodValidationPipe(CreatePriceBookBodySchema)) body: CreatePriceBookBody,
  ): Promise<PriceBookBody> {
    return mapErrors(() => this.service.createBook(writer(request), body));
  }

  @Get(BOOK)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  getBook(
    @Req() request: TenantContextRequest,
    @Param("bookId") bookId: string,
  ): Promise<{ book: PriceBookBody; zones: PriceZoneBody[] }> {
    const id = parseId(bookId, "bookId");
    return mapErrors(() => this.service.getBook(reader(request), id));
  }

  @Post(`${BOOK}/zones`)
  @HttpCode(201)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("write")
  createZone(
    @Req() request: TenantContextRequest,
    @Param("bookId") bookId: string,
    @Body(new ZodValidationPipe(CreatePriceZoneBodySchema)) body: CreatePriceZoneBody,
  ): Promise<PriceZoneBody> {
    const id = parseId(bookId, "bookId");
    return mapErrors(() => this.service.createZone(writer(request), id, body));
  }

  @Post(`${ZONE}/retire`)
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("write")
  retireZone(
    @Req() request: TenantContextRequest,
    @Param("bookId") bookId: string,
    @Param("zoneId") zoneId: string,
    @Body(new ZodValidationPipe(RetirePriceZoneBodySchema)) body: RetirePriceZoneBody,
  ): Promise<PriceZoneBody> {
    const target = { bookId: parseId(bookId, "bookId"), zoneId: parseId(zoneId, "zoneId") };
    return mapErrors(() => this.service.retireZone(writer(request), target, body));
  }

  @Get(`${ZONE}/stores`)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  listZoneStores(
    @Req() request: TenantContextRequest,
    @Param("bookId") bookId: string,
    @Param("zoneId") zoneId: string,
    @Query(new ZodValidationPipe(ZoneStoresQuerySchema)) query: ZoneStoresQuery,
  ): Promise<PriceZoneStorePageBody> {
    const target = { bookId: parseId(bookId, "bookId"), zoneId: parseId(zoneId, "zoneId") };
    return mapErrors(() => this.service.listZoneStores(reader(request), target, query));
  }

  @Get(STORE_MEMBERSHIPS)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  storeMemberships(
    @Req() request: TenantContextRequest,
    @Param("storeId") storeId: string,
    @Query(new ZodValidationPipe(StoreMembershipsQuerySchema)) query: StoreMembershipsQuery,
  ): Promise<StorePriceZoneMembershipsBody> {
    const id = parseId(storeId, "storeId");
    return mapErrors(() => this.service.storeMemberships(reader(request), id, query));
  }
}

/** A request-shape error, checked before any read: it discloses nothing. */
function parseId(value: string, name: string): string {
  if (!PathIdSchema.safeParse(value).success) {
    throw new BadRequestException({ code: "validation_error", message: `${name} must be a valid UUID` });
  }
  return value.toLowerCase();
}

function reader(request: TenantContextRequest): StructureReadInput {
  const ctx = request.context;
  if (ctx === undefined || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, context: ctx };
}

function writer(request: TenantContextRequest): StructureWriteInput {
  const read = reader(request);
  const userId = read.context.userId;
  if (userId === null) throw new UnauthorizedException("Unauthorized");
  return { ...read, actorUserId: userId, requestId: request.requestId ?? null };
}

/** Runs `work`, answering a service refusal with the contract's 4xx; anything else propagates (500). */
function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  // `then(work)` also catches a refusal `work` throws synchronously (a cursor it cannot decode).
  return Promise.resolve()
    .then(work)
    .catch((err: unknown) => {
    throw httpErrorOf(err);
  });
}

function httpErrorOf(err: unknown): unknown {
  if (err instanceof PriceStructureNotFoundError) return new NotFoundException(NOT_FOUND);
  if (err instanceof PriceStructureConflictError) {
    return new HttpException({ code: err.code, message: CONFLICT_MESSAGES[err.code] }, 409);
  }
  if (err instanceof PricingRevisionUnknownError) {
    return new UnprocessableEntityException({
      code: "pricing_revision_unknown",
      message: "The tenant has not published this Pricing Revision.",
    });
  }
  if (err instanceof ZoneStoresCursorError) return new BadRequestException({ code: "validation_error", message: err.message });
  return err;
}

/**
 * StockLevelsController — RT-1066: the console read and writes of a product's
 * low-stock thresholds (`catalog/stock-levels.yaml` 1.0.0-draft; decision
 * record RT-1064 TH-1 to TH-5).
 *
 *   GET  /api/v1/catalog/products/{productId}/stock-levels                         consoleGetProductStockLevels
 *   PUT  /api/v1/catalog/products/{productId}/stock-levels                         consoleSetTenantStockLevel
 *   POST /api/v1/catalog/products/{productId}/stock-levels/retire                  consoleRetireTenantStockLevel
 *   PUT  /api/v1/catalog/products/{productId}/stock-levels/stores/{storeId}        consoleSetStoreStockLevel
 *   POST /api/v1/catalog/products/{productId}/stock-levels/stores/{storeId}/retire consoleRetireStoreStockLevel
 *
 * Auth (TH-4): the console catalog chain. `SessionOnlyAdminGuard` (every
 * bearer is 401; a cookie write without a trusted `Origin` is 403
 * `origin_rejected`, RT-430), then `TenantContextGuard`, then `RolesGuard`
 * (default deny → the non-disclosing 404): the read is owner / tenant_admin /
 * store_manager; the tenant level writes are CAT-W1 (owner / tenant_admin);
 * the store level writes are CAT-W2 (adding store_manager, for a store in its
 * scope). The tenant and the actor are the session's (§XII).
 *
 * Both sets are `@Idempotent("required")` (the shared `IdempotencyInterceptor`,
 * which runs after the guards and before the body pipe). Every audit row is
 * written by the service in the write's transaction, so no handler carries
 * `@Auditable`. Every 200 is `Cache-Control: no-store`. Console rate-limit
 * classes (`classes/catalog/stock-levels.rate-limit.yaml`): the read is
 * `cheapRead`, the writes `write` (their verb default).
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
  Put,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";

import { Roles } from "../../auth/roles.decorator";
import { RolesGuard } from "../../auth/roles.guard";
import { SessionOnlyAdminGuard } from "../../auth/session-only-admin.guard";
import { ZodValidationPipe } from "../../common/zod-validation.pipe";
import { ConsoleRateLimit } from "../../console-rate-limit/console-rate-limit.decorator";
import { TenantContextGuard } from "../../context/tenant-context.guard";
import type { TenantContextRequest } from "../../context/types";
import { Idempotent } from "../../idempotency/idempotent.decorator";
import { ProductIdParamSchema } from "../console-catalog/console-catalog.query";
import {
  RetireStockLevelBodySchema,
  SetStockLevelBodySchema,
  type RetireStockLevelBody,
  type SetStockLevelBody,
} from "./stock-levels.bodies";
import {
  StockLevelNotFoundError,
  StockLevelRefusedError,
  StockLevelsService,
  type ProductStockLevels,
  type StockLevelsReadInput,
  type StockLevelsWriteInput,
} from "./stock-levels.service";

const LEVELS = "api/v1/catalog/products/:productId/stock-levels";
const STORE_LEVEL = `${LEVELS}/stores/:storeId`;

/** The one 404 body of this surface, equal to the `RolesGuard` refusal (FR-ISO-4). */
const NOT_FOUND = { code: "not_found", message: "Not Found" } as const;

const REFUSAL_MESSAGES: Readonly<Record<StockLevelRefusedError["code"], string>> = {
  stale_write: "The stock level changed since it was read. Reload and retry.",
  product_retired: "The product is retired.",
  critical_above_reorder: "The critical level must not be above the reorder level.",
};

@Controller()
@UseGuards(SessionOnlyAdminGuard, TenantContextGuard)
export class StockLevelsController {
  constructor(private readonly service: StockLevelsService) {}

  @Get(LEVELS)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  @ConsoleRateLimit("cheapRead")
  read(
    @Req() request: TenantContextRequest,
    @Param("productId") productId: string,
    @Query() query: Record<string, unknown>,
  ): Promise<ProductStockLevels> {
    const scoped = reader(request);
    rejectAnyQuery(query);
    const id = parseId(productId, "productId");
    return mapErrors(() => this.service.read(scoped, id));
  }

  @Put(LEVELS)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  setTenant(
    @Req() request: TenantContextRequest,
    @Param("productId") productId: string,
    @Query() query: Record<string, unknown>,
    @Body(new ZodValidationPipe(SetStockLevelBodySchema)) body: SetStockLevelBody,
  ): Promise<ProductStockLevels> {
    const input = writer(request);
    rejectAnyQuery(query);
    const id = parseId(productId, "productId");
    return mapErrors(() => this.service.set(input, { productId: id, storeId: null }, body));
  }

  @Post(`${LEVELS}/retire`)
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin")
  @Header("Cache-Control", "no-store")
  retireTenant(
    @Req() request: TenantContextRequest,
    @Param("productId") productId: string,
    @Query() query: Record<string, unknown>,
    @Body(new ZodValidationPipe(RetireStockLevelBodySchema)) body: RetireStockLevelBody,
  ): Promise<ProductStockLevels> {
    const input = writer(request);
    rejectAnyQuery(query);
    const id = parseId(productId, "productId");
    return mapErrors(() => this.service.retire(input, { productId: id, storeId: null }, body));
  }

  @Put(STORE_LEVEL)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Idempotent("required")
  @Header("Cache-Control", "no-store")
  setStore(
    @Req() request: TenantContextRequest,
    @Param("productId") productId: string,
    @Param("storeId") storeId: string,
    @Query() query: Record<string, unknown>,
    @Body(new ZodValidationPipe(SetStockLevelBodySchema)) body: SetStockLevelBody,
  ): Promise<ProductStockLevels> {
    const input = writer(request);
    rejectAnyQuery(query);
    const id = parseId(productId, "productId");
    const store = parseId(storeId, "storeId");
    return mapErrors(() => this.service.set(input, { productId: id, storeId: store }, body));
  }

  @Post(`${STORE_LEVEL}/retire`)
  @HttpCode(200)
  @UseGuards(RolesGuard)
  @Roles("owner", "tenant_admin", "store_manager")
  @Header("Cache-Control", "no-store")
  retireStore(
    @Req() request: TenantContextRequest,
    @Param("productId") productId: string,
    @Param("storeId") storeId: string,
    @Query() query: Record<string, unknown>,
    @Body(new ZodValidationPipe(RetireStockLevelBodySchema)) body: RetireStockLevelBody,
  ): Promise<ProductStockLevels> {
    const input = writer(request);
    rejectAnyQuery(query);
    const id = parseId(productId, "productId");
    const store = parseId(storeId, "storeId");
    return mapErrors(() => this.service.retire(input, { productId: id, storeId: store }, body));
  }
}

function validationError(message: string): BadRequestException {
  return new BadRequestException({ code: "validation_error", message });
}

/** A request-shape error, checked before any read: it discloses nothing. */
function rejectAnyQuery(query: Record<string, unknown>): void {
  if (Object.keys(query).length > 0) throw validationError("this operation takes no query parameter");
}

/** A request-shape error, checked before any read: it discloses nothing. */
function parseId(value: string, name: string): string {
  const parsed = ProductIdParamSchema.safeParse(value);
  if (!parsed.success) throw validationError(`${name} must be a valid UUID`);
  return parsed.data;
}

/** The session tenant and the context whose store scope bounds the store levels. */
function reader(request: TenantContextRequest): StockLevelsReadInput {
  const ctx = request.context;
  if (ctx === undefined || ctx.tenantId === null) throw new UnauthorizedException("Unauthorized");
  return { tenantId: ctx.tenantId, context: ctx };
}

/** The session tenant, the actor and the request id of a write. */
function writer(request: TenantContextRequest): StockLevelsWriteInput {
  const scoped = reader(request);
  const userId = scoped.context.userId;
  if (userId === null) throw new UnauthorizedException("Unauthorized");
  return { ...scoped, actorUserId: userId, requestId: request.requestId ?? null };
}

/** Maps the service's refusals to the contract's 4xx; anything else propagates (500). */
async function mapErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof StockLevelNotFoundError) throw new NotFoundException(NOT_FOUND);
    if (err instanceof StockLevelRefusedError) {
      throw new HttpException({ code: err.code, message: REFUSAL_MESSAGES[err.code] }, err.status);
    }
    throw err;
  }
}

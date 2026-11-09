/**
 * RT-1298: guard of the pilot registry writes that the promotion workflow makes
 * (`platformRegisterPilotRelease`, `platformWithdrawPilotRelease`).
 *
 * The routes are `@Public()` for the global cookie guard (`FailClosedAuthGuard`
 * would otherwise demand a Console session) and are authenticated HERE, by the
 * workflow's GitHub OIDC bearer only:
 *
 *   - no `Authorization: Bearer` header, or the promotion lane is off (any pin
 *     unset): 401 without verifying anything. A Console cookie, a device token
 *     or any other credential is therefore 401;
 *   - the verifier says 401: 401; it says 403 (a genuine token with other claims
 *     than the pins): 403 `forbidden`;
 *   - success: the principal (actor, run id, repository) is attached to the
 *     request. No token or claim is ever put in an error.
 */
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import {
  PROMOTION_OIDC_VERIFIER,
  type PromotionOidcVerifier,
  type PromotionPrincipal,
} from "./promotion-oidc.verifier";

/** The request as this guard and the writes controller see it. */
export interface PromotionRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  promotionPrincipal?: PromotionPrincipal;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** The bearer token of an Authorization header, or null. */
function bearerOf(header: string | string[] | undefined): string | null {
  return typeof header === "string" ? (BEARER.exec(header.trim())?.[1] ?? null) : null;
}

/** Authenticates the promotion workflow's GitHub OIDC token; see the file comment. */
@Injectable()
export class PromotionWriterGuard implements CanActivate {
  constructor(@Inject(PROMOTION_OIDC_VERIFIER) private readonly verifier: PromotionOidcVerifier | null) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PromotionRequest>();
    const token = bearerOf(request.headers["authorization"]);
    if (token === null || this.verifier === null) throw new UnauthorizedException("Unauthorized");

    const verdict = await this.verifier.verify(token);
    if (verdict.ok) {
      request.promotionPrincipal = verdict.principal;
      return true;
    }
    if (verdict.status === 403) throw new ForbiddenException({ code: "forbidden", message: "Forbidden" });
    throw new UnauthorizedException("Unauthorized");
  }
}

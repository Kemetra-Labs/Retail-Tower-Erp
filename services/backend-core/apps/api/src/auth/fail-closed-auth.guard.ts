/**
 * Global fail-closed guard (#615).
 *
 * No marker means "authenticate with AuthGuard" (cookie or opaque bearer).
 * `@Public()` is the only way to skip authentication. Operator-token and
 * device-attested routes declare their credential and do not fall through
 * to the opaque-token lookup, which would reject an identity-provider JWT.
 *
 * RT-630: when AuthGuard refuses with 401, the optional report-only
 * PreAuthRateLimitReporter counts the failure per client IP, then the same
 * 401 is rethrown unchanged. The reporter never refuses and never throws.
 */
import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { AuthGuard, type AuthedRequest } from "./auth.guard";
import { OperatorBearerGuard } from "./operator-bearer.guard";
import { DeviceAttestedGuard } from "./device-attested.guard";
import {
  OPERATOR_BEARER_KEY,
  DEVICE_ATTESTED_KEY,
  DEVICE_BEARER_KEY,
  IS_PUBLIC_KEY,
} from "./route-auth";
import { PreAuthRateLimitReporter } from "../preauth-rate-limit/preauth-rate-limit.reporter";

@Injectable()
export class FailClosedAuthGuard implements CanActivate {
  private readonly operatorBearer = new OperatorBearerGuard();
  private readonly deviceAttested = new DeviceAttestedGuard();

  constructor(
    private readonly reflector: Reflector,
    private readonly authGuard: AuthGuard,
    @Optional() private readonly preAuthReporter?: PreAuthRateLimitReporter,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets) === true) {
      return true;
    }
    if (this.reflector.getAllAndOverride<boolean>(OPERATOR_BEARER_KEY, targets) === true) {
      return this.operatorBearer.canActivate(context);
    }
    if (this.reflector.getAllAndOverride<boolean>(DEVICE_ATTESTED_KEY, targets) === true) {
      return this.deviceAttested.canActivate();
    }
    if (this.reflector.getAllAndOverride<boolean>(DEVICE_BEARER_KEY, targets) === true) {
      return true;
    }
    return await this.authenticate(context);
  }

  private async authenticate(context: ExecutionContext): Promise<boolean> {
    try {
      return await this.authGuard.canActivate(context);
    } catch (err) {
      if (err instanceof UnauthorizedException && this.preAuthReporter) {
        await this.preAuthReporter.report(context.switchToHttp().getRequest<AuthedRequest>());
      }
      throw err;
    }
  }
}

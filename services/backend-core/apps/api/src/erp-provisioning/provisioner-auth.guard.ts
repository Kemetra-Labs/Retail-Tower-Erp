/**
 * ProvisionerAuthGuard — RT-1358: the verifier of `connectorProvisionerBearer`.
 *
 * Standalone (it does NOT extend `AuthGuard`): the scope `connector_provisioner`
 * stays out of `BEARER_AUTH_SCOPES`, so every other guard keeps refusing it.
 *
 *   1. the bearer resolves through `AuthTokenRepository.findActiveByRawToken`
 *      (hash match, unrevoked, unexpired, on the auth-lookup pool);
 *   2. its scope must be `connector_provisioner` (a tenant `connector`, device,
 *      dashboard or POS token, and a cookie session, are the generic 401);
 *   3. a short, READ-ONLY, platform-admin transaction reads the unrevoked
 *      `erp_provisioner_credential` of the token for its host label and
 *      environment (the provisioner policy cannot read that table, and the
 *      lookup role holds no grant on it). This transaction never sets
 *      `app.is_provisioner`: the provisioner and platform-admin settings are
 *      never together;
 *   4. the credential's environment must equal `DEPLOYMENT_ENVIRONMENT`, else a
 *      generic 403 `forbidden` (the body names neither environment).
 *
 * The principal published on the request carries the token id and the host
 * label only; the token itself is not propagated past this guard.
 */
import { type CanActivate, type ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { runWithTenantContext } from "@data-pulse-2/db";
import type { Pool } from "pg";

import { type AuthedRequest, readBearerToken } from "../auth/auth.guard";
import { AuthTokenRepository } from "../auth/auth-token.repository";
import { PG_POOL } from "../auth/database-pools";
import { recordAuthFailure } from "../observability/metrics/api.metrics";
import { resolveDeploymentEnvironment } from "../connector/deployment-environment";

const PROVISIONER_SCOPE = "connector_provisioner";

interface ProvisionerPrincipal {
  readonly tokenId: string;
  readonly hostLabel: string;
}

export type ProvisionerRequest = AuthedRequest & { provisioner?: ProvisionerPrincipal };

@Injectable()
export class ProvisionerAuthGuard implements CanActivate {
  constructor(
    private readonly authTokens: AuthTokenRepository,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ProvisionerRequest>();
    const raw = readBearerToken(request);
    if (raw === null) {
      recordAuthFailure({ cause: "missing" });
      throw new UnauthorizedException("Unauthorized");
    }
    const token = await this.authTokens.findActiveByRawToken(raw);
    if (!token || token.scope !== PROVISIONER_SCOPE) {
      recordAuthFailure({ cause: "bad_token" });
      throw new UnauthorizedException("Unauthorized");
    }
    const credential = await runWithTenantContext(this.pool, { tenantId: null, isPlatformAdmin: true }, async (client) => {
      const r = await client.query<{ host_label: string; environment: string }>(
        `SELECT host_label, environment FROM erp_provisioner_credential WHERE token_id = $1::uuid AND revoked_at IS NULL`,
        [token.id],
      );
      return r.rows[0] ?? null;
    });
    if (credential === null) {
      recordAuthFailure({ cause: "bad_token" });
      throw new UnauthorizedException("Unauthorized");
    }
    const deployment = resolveDeploymentEnvironment();
    if (deployment === null || credential.environment !== deployment) {
      throw new ForbiddenException({ code: "forbidden", message: "Forbidden" });
    }
    request.provisioner = { tokenId: token.id, hostLabel: credential.host_label };
    return true;
  }
}

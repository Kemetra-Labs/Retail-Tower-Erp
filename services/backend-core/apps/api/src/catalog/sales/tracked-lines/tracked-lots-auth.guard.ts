/**
 * TrackedLotsAuthGuard — the credential gate of the POS lot lookup
 * (`posListTrackedLots`, `pos-sales/tracked-lines.yaml`; Jira RT-451 slice S1).
 *
 * The contract declares two ALTERNATIVE credentials and, unlike captureSale,
 * names no operator on the device path ("the device token alone, as the
 * catalog read-down does: it names no operator and returns no
 * operator-specific data"):
 *
 *   1. Envelope path: `PosOperatorEnvelopeSaleGuard`, unchanged (canonical
 *      `pos_operator` bearer auth plus the live membership / device /
 *      store-access re-verification, 031 G-4). The envelope's store is the
 *      caller's store.
 *   2. Device path: only when the envelope guard answered its generic 401,
 *      `PosDeviceAuthGuard` resolves the same bearer as a paired device of an
 *      active tenant; tenant and store come from the device row. No actor is
 *      published, so nothing can be attributed to an operator.
 *
 * Both tokens are opaque bearers in the same header, so the paths are tried in
 * this order (the sale-history composite's probe, RT-539). A credential that
 * neither accepts is the envelope's generic 401; a non-401 envelope error and
 * a non-401 device error propagate. Nothing in the request selects a path or
 * a scope (§II, §XII).
 *
 * The route carries `@DeviceBearer()` so the global FailClosedAuthGuard defers
 * here; route-auth-markers.enforcement.spec.ts lists this guard as a reviewed
 * composite that runs PosDeviceAuthGuard.
 */
import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

import { PosDeviceAuthGuard } from "../../../auth/pos-device-auth.guard";
import { PosOperatorEnvelopeSaleGuard } from "../../../auth/pos-operator-envelope-sale.guard";

type Gate = Pick<CanActivate, "canActivate">;

@Injectable()
export class TrackedLotsAuthGuard implements CanActivate {
  // Class-referenced on the route, so reflection-instantiated from the module's
  // envelope and device guard providers (SalesModule).
  constructor(
    @Inject(PosOperatorEnvelopeSaleGuard) private readonly envelope: Gate,
    @Inject(PosDeviceAuthGuard) private readonly device: Gate,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    let envelopeRefusal: UnauthorizedException;
    try {
      if ((await this.envelope.canActivate(context)) === true) return true;
      envelopeRefusal = new UnauthorizedException("Unauthorized");
    } catch (err) {
      if (!(err instanceof UnauthorizedException)) throw err;
      envelopeRefusal = err;
    }
    try {
      if ((await this.device.canActivate(context)) === true) return true;
    } catch (err) {
      if (!(err instanceof UnauthorizedException)) throw err;
    }
    throw envelopeRefusal;
  }
}

/**
 * The destination store of a transfer must be within the caller's membership store access (RT-61 / RT-120). Unlike the
 * source it is not tied to the active store: a tenant-wide member with an active store may transfer to any store in the
 * tenant, a 'specific' member only to stores it is granted. A store outside it is a non-disclosing 404. One definition for the
 * instant transfer (`InventoryController`) and the shipment Transfer (RT-1513, `ShipmentTransfersService`).
 */
import { NotFoundException } from '@nestjs/common';

import type { ResolvedContext } from '../context/types';

export function authorizeDestinationStoreAccess(ctx: ResolvedContext, storeId: string): void {
  if (ctx.source !== 'session') return;
  const access = ctx.storeAccess;
  if (access?.kind === 'all') return;
  if (access?.kind === 'specific' && access.storeIds.includes(storeId)) return;
  throw new NotFoundException('Not Found');
}

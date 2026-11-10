/**
 * RT-1312 query hooks over the device-health reads, for the till's unsent sales.
 *
 * The list and the health read do not page together: devices come in the server's
 * exception-first order, health rows by `deviceId`. So the list surface reads the
 * health of every device in the SAME scope and filters (store, trust state), page
 * by page up to a bound, and joins by `deviceId`. A device past the bound, or with
 * no health row, reads as unavailable, never as Unknown or 0.
 *
 * A health failure never becomes the page's failure: a 404/403 (a role or scope
 * that cannot read health, or a server without the route) is `unavailable`; any
 * other failure is `failed`, which the list offers to retry.
 */
import {
  type DeviceHealthListQuery,
  type DeviceHealthPage,
  type DeviceHealthView,
  consoleGetDeviceHealth,
  consoleListDeviceHealth,
} from "@/lib/device-health-queries";
import { useQuery } from "@tanstack/react-query";
import type { DeviceFilters } from "./deviceFilters";
import { isUuid, requestIdOf } from "./deviceLogic";
import {
  type HealthStatus,
  type SaleQueueState,
  healthIndex,
  saleQueueStateOf,
} from "./saleQueueLogic";
import type { DeviceScope } from "./useDevices";

/** The contract's largest page. */
const HEALTH_PAGE_SIZE = 200;
/** At most this many pages (5,000 devices) per read; the rest read as unavailable. */
const MAX_HEALTH_PAGES = 25;

type ScopeKey = Pick<DeviceScope, "tenantId" | "activeStoreId">;

class HealthReadError extends Error {
  constructor(
    readonly refused: boolean,
    readonly requestId?: string,
  ) {
    super("device-health");
  }
}

function dataOrThrow<P>(res: { status: number; data?: P; error?: unknown }): P {
  if (res.status >= 400 || !res.data) {
    throw new HealthReadError(res.status === 403 || res.status === 404, requestIdOf(res.error));
  }
  return res.data;
}

function statusOf(result: { isLoading: boolean; error: unknown; data?: unknown }): HealthStatus {
  if (result.error) {
    return result.error instanceof HealthReadError && result.error.refused
      ? "unavailable"
      : "failed";
  }
  if (result.data !== undefined) return "ready";
  return result.isLoading ? "loading" : "unavailable";
}

function healthListQuery(filters: DeviceFilters): DeviceHealthListQuery {
  const query: DeviceHealthListQuery = { page_size: HEALTH_PAGE_SIZE };
  if (filters.storeId) query.store_id = filters.storeId;
  if (filters.trustState) query.trust_state = filters.trustState;
  return query;
}

async function readAllPages(query: DeviceHealthListQuery): Promise<DeviceHealthPage[]> {
  const pages: DeviceHealthPage[] = [];
  let cursor: string | undefined;
  do {
    const page = dataOrThrow(await consoleListDeviceHealth(cursor ? { ...query, cursor } : query));
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor && pages.length < MAX_HEALTH_PAGES);
  return pages;
}

export interface DeviceHealthIndex {
  status: HealthStatus;
  byId: ReadonlyMap<string, DeviceHealthView>;
  /** The failed read's request id, for the operator to quote. */
  requestId?: string;
  retry: () => void;
}

const EMPTY = new Map<string, DeviceHealthView>();

export function useDeviceHealthIndex(scope: ScopeKey, filters: DeviceFilters): DeviceHealthIndex {
  const query = healthListQuery(filters);
  const result = useQuery({
    queryKey: ["devices", "health", "list", scope.tenantId, scope.activeStoreId, query],
    enabled: Boolean(scope.tenantId),
    queryFn: () => readAllPages(query).then(healthIndex),
    retry: false,
  });
  return {
    status: statusOf(result),
    byId: result.data ?? EMPTY,
    requestId: result.error instanceof HealthReadError ? result.error.requestId : undefined,
    retry: () => void result.refetch(),
  };
}

/** One device's sale-queue state, for the detail Overview. */
export function useDeviceSaleQueue(scope: ScopeKey, deviceId: string | undefined): SaleQueueState {
  const enabled = Boolean(scope.tenantId) && isUuid(deviceId);
  const result = useQuery({
    queryKey: ["devices", "health", "detail", scope.tenantId, scope.activeStoreId, deviceId],
    enabled,
    queryFn: () => consoleGetDeviceHealth(String(deviceId)).then(dataOrThrow),
    retry: false,
  });
  return saleQueueStateOf(result.data, statusOf(result));
}

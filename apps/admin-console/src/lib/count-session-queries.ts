/**
 * RT-1425 data layer: typed wrappers over the generated `apiClient` for the
 * Backend-Core Count Session operations of `inventory/inventory.yaml` (RT-1419,
 * RT-292 Gate 6). Every shape is a projection of the generated schema; there are
 * no hand-written contract types.
 *
 * Boundary: the eleven Count Session operations and nothing else. The legacy
 * `recordStockCount` route, the stock-on-hand reads and every ERP system stay
 * out: capture is blind, so no expected or on-hand quantity is ever read here.
 * Same `{ status, data?, error?, retryAfter? }` shape as `inventory-queries.ts`.
 */
import { apiClient } from "@/generated/client";
import type { InventorySchema } from "@/generated/schema";
import { classifyRateLimit } from "@/lib/rate-limit";

type Schemas = InventorySchema.components["schemas"];

export type CountSession = Schemas["CountSession"];
export type CountSessionState = Schemas["CountSessionState"];
export type CountSessionList = Schemas["CountSessionList"];
export type CreateCountSessionCommand = Schemas["CreateCountSessionCommand"];
export type CountObservationInput = Schemas["CountObservationInput"];
export type CountObservationsResult = Schemas["CountObservationsResult"];
export type CountVarianceLine = Schemas["CountVarianceLine"];
export type CountVarianceLineList = Schemas["CountVarianceLineList"];
export type CountVarianceFlag = Schemas["CountVarianceFlag"];
export type CountLateEventFinding = Schemas["CountLateEventFinding"];
export type CountLateEventFindingList = Schemas["CountLateEventFindingList"];
export type RequestCountRecountCommand = Schemas["RequestCountRecountCommand"];
export type ApproveCountSessionCommand = Schemas["ApproveCountSessionCommand"];
export type InventoryStatus = Schemas["InventoryStatus"];
export type CountCutBarrierDetails = Schemas["CountCutBarrierDetails"];
export type CountSelfApprovalSetting = Schemas["CountSelfApprovalSetting"];
export type SetCountSelfApprovalCommand = Schemas["SetCountSelfApprovalCommand"];
export type CountSessionsSetting = Schemas["CountSessionsSetting"];
export type CountSessionsReadinessBoundary = Schemas["CountSessionsReadinessBoundary"];
export type SetCountSessionsSettingCommand = Schemas["SetCountSessionsSettingCommand"];

export interface CountPageQuery {
  cursor?: string;
  limit?: number;
}

function resultOf<D, E>(res: { data?: D; error?: E; response: Response }) {
  const { response } = res;
  return {
    status: response.status,
    data: res.data,
    error: res.error,
    retryAfter: classifyRateLimit({
      status: response.status,
      retryAfter: response.headers.get("Retry-After"),
    })?.retryAfterSeconds,
  };
}

const SESSIONS = "/api/inventory/v1/stores/{storeId}/count-sessions" as const;
const SESSION = `${SESSIONS}/{sessionId}` as const;

/** GET .../count-sessions: the store's sessions, newest first, keyset paged. */
export async function listCountSessions(
  storeId: string,
  query: CountPageQuery & { state?: CountSessionState } = {},
) {
  return resultOf(await apiClient.GET(SESSIONS, { params: { path: { storeId }, query } }));
}

/** GET .../count-sessions/{sessionId} */
export async function getCountSession(storeId: string, sessionId: string) {
  return resultOf(await apiClient.GET(SESSION, { params: { path: { storeId, sessionId } } }));
}

/** POST .../count-sessions: opens a session (Idempotency-Key required). */
export async function createCountSession(
  storeId: string,
  command: CreateCountSessionCommand,
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST(SESSIONS, {
      params: { path: { storeId }, header: { "Idempotency-Key": idempotencyKey } },
      body: command,
    }),
  );
}

/** POST .../observations: counted quantities at position grain (Idempotency-Key required). */
export async function recordCountObservations(
  storeId: string,
  sessionId: string,
  observations: CountObservationInput[],
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST(`${SESSION}/observations`, {
      params: { path: { storeId, sessionId }, header: { "Idempotency-Key": idempotencyKey } },
      body: { observations },
    }),
  );
}

/** POST .../cut: takes the Count Cut (refused until the barrier holds). */
export async function takeCountCut(storeId: string, sessionId: string, idempotencyKey: string) {
  return resultOf(
    await apiClient.POST(`${SESSION}/cut`, {
      params: { path: { storeId, sessionId }, header: { "Idempotency-Key": idempotencyKey } },
    }),
  );
}

/** POST .../submit: sends the captured counts for review. */
export async function submitCountSession(
  storeId: string,
  sessionId: string,
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST(`${SESSION}/submit`, {
      params: { path: { storeId, sessionId }, header: { "Idempotency-Key": idempotencyKey } },
    }),
  );
}

/** GET .../variance-lines: the review lines (from `submitted`; 409 before). */
export async function listCountVarianceLines(
  storeId: string,
  sessionId: string,
  query: CountPageQuery = {},
) {
  return resultOf(
    await apiClient.GET(`${SESSION}/variance-lines`, {
      params: { path: { storeId, sessionId }, query },
    }),
  );
}

/** POST .../recount: sends listed products back for a recount. */
export async function requestCountRecount(
  storeId: string,
  sessionId: string,
  command: RequestCountRecountCommand,
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST(`${SESSION}/recount`, {
      params: { path: { storeId, sessionId }, header: { "Idempotency-Key": idempotencyKey } },
      body: command,
    }),
  );
}

/** POST .../approve: approval under the approval policy, with acknowledgements. */
export async function approveCountSession(
  storeId: string,
  sessionId: string,
  command: ApproveCountSessionCommand,
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST(`${SESSION}/approve`, {
      params: { path: { storeId, sessionId }, header: { "Idempotency-Key": idempotencyKey } },
      body: command,
    }),
  );
}

/** POST .../cancel: cancels a session before approval, with a reason. */
export async function cancelCountSession(
  storeId: string,
  sessionId: string,
  reason: string,
  idempotencyKey: string,
) {
  return resultOf(
    await apiClient.POST(`${SESSION}/cancel`, {
      params: { path: { storeId, sessionId }, header: { "Idempotency-Key": idempotencyKey } },
      body: { reason },
    }),
  );
}

/** GET .../late-event-findings: late pre-cut events, oldest first. */
export async function listCountLateEventFindings(
  storeId: string,
  sessionId: string,
  query: CountPageQuery = {},
) {
  return resultOf(
    await apiClient.GET(`${SESSION}/late-event-findings`, {
      params: { path: { storeId, sessionId }, query },
    }),
  );
}

const SELF_APPROVAL = "/api/inventory/v1/settings/count-self-approval" as const;

/** GET .../settings/count-self-approval: the owner's small-shop exception (owner only). */
export async function getCountSelfApprovalSetting() {
  return resultOf(await apiClient.GET(SELF_APPROVAL));
}

/** PUT .../settings/count-self-approval: whole-value, owner only, a reason when enabling. */
export async function setCountSelfApprovalSetting(command: SetCountSelfApprovalCommand) {
  return resultOf(await apiClient.PUT(SELF_APPROVAL, { body: command }));
}

const ACTIVATION = "/api/inventory/v1/settings/count-sessions" as const;

/** GET .../settings/count-sessions: the tenant's activation switch and its readiness (RT-1423). */
export async function getCountSessionsSetting() {
  return resultOf(await apiClient.GET(ACTIVATION));
}

/** PUT .../settings/count-sessions: whole-value on or off; the server refuses with a typed 409. */
export async function setCountSessionsSetting(command: SetCountSessionsSettingCommand) {
  return resultOf(await apiClient.PUT(ACTIVATION, { body: command }));
}

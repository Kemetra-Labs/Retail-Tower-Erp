/**
 * RT-1487 — the delta half of the live read-down client: `GET
 * /api/pos/v1/catalog/deltas?since=<cursor>` (`posGetCatalogDeltas`,
 * `catalog/read-down.yaml`, decisions 424–431).
 *
 * Contract: ordered `upsert` / `remove_from_sellable` ops after the opaque
 * `since` cursor, cursor-paginated via `next_page_token`, each page carrying the
 * advanced `cursor` (the last page's wins; see `fetchCatalogDeltas`). A cursor older than the server's
 * retained change log is a `409` whose `error.code` is `snapshot_required`.
 *
 * Same transport rules as the snapshot: device bearer only, never throws, a
 * transport fault is `no_connection`, a 401 is `device_unauthorized`, and any
 * failed or malformed page fails the whole fetch — a partial delta is never
 * returned, so the writer can never apply a gap.
 */

import type { ReadDownDeltaOp, ReadDownDeltaResult } from './read-down-client-types.js';
import { isSellableCatalogRow } from './sellable-row-guard.js';

const SINCE_PARAM = 'since';
/**
 * Delta pages walked before re-baselining with a snapshot. At the server's
 * default 500 changes per page this is 25,000 changed products.
 */
export const DELTA_MAX_PAGES = 50;
/** The 409 error code for a stale/unservable cursor (contract `SnapshotRequired`). */
const SNAPSHOT_REQUIRED_CODE = 'snapshot_required';

/** What the delta fetch borrows from the client factory. */
interface DeltaFetchDeps {
  /** Base URL without a trailing slash. */
  root: string;
  /** The `posGetCatalogDeltas` route (`DELTAS_PATH` in `read-down-client.ts`). */
  path: string;
  /** Re-read before every page (RT-215); `null` = not sendable. */
  sendableToken: () => Promise<string | null>;
  /** GET with the device bearer; `null` on a transport fault. Never throws. */
  send: (deviceToken: string, url: URL) => Promise<Response | null>;
}

interface ValidDeltaPage {
  ops: ReadDownDeltaOp[];
  cursor: string;
  nextPageToken: string | null;
}

type DeltaPageResult =
  | { kind: 'ok'; page: ValidDeltaPage }
  | { kind: 'snapshot_required' }
  | { kind: 'no_connection' }
  | { kind: 'failed' }
  | { kind: 'device_unauthorized' };

/**
 * Narrow one `CatalogDeltaOp`. An `upsert` must carry a valid row for the same
 * product; a `remove_from_sellable` needs only the product id. Anything else
 * (unknown op, missing id, mismatched row) is malformed → `null`.
 */
function parseDeltaOp(value: unknown): ReadDownDeltaOp | null {
  const op = asRecord(value);
  const productId = nonEmptyString(op?.['product_id']);
  if (op === null || productId === null) return null;
  if (op['op'] === 'remove_from_sellable') {
    return { op: 'remove_from_sellable', productId };
  }
  return op['op'] === 'upsert' ? parseUpsert(productId, op['row']) : null;
}

/** An `upsert` must carry a structurally valid row for the SAME product. */
function parseUpsert(productId: string, row: unknown): ReadDownDeltaOp | null {
  if (!isSellableCatalogRow(row) || row.product_id !== productId) return null;
  return { op: 'upsert', productId, row };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Parse `next_page_token` (`[string, "null"]`); `undefined` = malformed. */
function parseNextPageToken(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') return undefined;
  return raw.length > 0 ? raw : null;
}

/**
 * Parse every op; `null` when any one is malformed. One bad op fails the page:
 * a delta applied with a gap would leave a stale row sellable.
 */
function parseOps(rawOps: unknown): ReadDownDeltaOp[] | null {
  if (!Array.isArray(rawOps)) return null;
  const ops: ReadDownDeltaOp[] = [];
  for (const raw of rawOps) {
    const op = parseDeltaOp(raw);
    if (op === null) return null;
    ops.push(op);
  }
  return ops;
}

/** Validate a reachable `CatalogDeltaPage` body; `null` = malformed. */
function parseDeltaPage(parsed: unknown): ValidDeltaPage | null {
  const body = asRecord(parsed);
  const cursor = nonEmptyString(body?.['cursor']);
  const ops = parseOps(body?.['ops']);
  const nextPageToken = parseNextPageToken(body?.['next_page_token']);
  if (cursor === null || ops === null || nextPageToken === undefined) return null;
  return { ops, cursor, nextPageToken };
}

/** Does a 409 body carry the contract's `snapshot_required` error code? */
async function isSnapshotRequired(response: Response): Promise<boolean> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } } | null;
    return body?.error?.code === SNAPSHOT_REQUIRED_CODE;
  } catch {
    return false;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return (await response.json()) as unknown;
  } catch {
    return undefined;
  }
}

/** Fetch + validate ONE delta page after `since`. */
async function fetchDeltaPage(
  deps: DeltaFetchDeps,
  deviceToken: string,
  since: string,
): Promise<DeltaPageResult> {
  const url = new URL(`${deps.root}${deps.path}`);
  url.searchParams.set(SINCE_PARAM, since);
  const response = await deps.send(deviceToken, url);
  if (response === null) return { kind: 'no_connection' };
  if (response.status === 401) return { kind: 'device_unauthorized' };
  if (response.status === 409) {
    return (await isSnapshotRequired(response))
      ? { kind: 'snapshot_required' }
      : { kind: 'failed' };
  }
  if (!response.ok) return { kind: 'failed' };
  const page = parseDeltaPage(await readJson(response));
  return page === null ? { kind: 'failed' } : { kind: 'ok', page };
}

/**
 * Walk every delta page after `since`, in order. Backend-Core's deltas route
 * pages by `since` only (it takes no `page_token`; `read-down.controller.ts`):
 * each page's `cursor` is the last change it emitted, so the next page is
 * requested with `since = page.cursor`. The contract also defines that cursor as
 * the value to pass as `since`, so this works for a server that honours
 * `page_token` too.
 *
 *   • A page that says there is more but does not advance the cursor fails the
 *     fetch, so a server that ignores pagination can never loop.
 *   • More than `DELTA_MAX_PAGES` pages means the terminal is far behind: it
 *     re-baselines with a full snapshot (cheaper than walking on, and the ops are
 *     held in memory until applied).
 */
export async function fetchCatalogDeltas(
  deps: DeltaFetchDeps,
  since: string,
): Promise<ReadDownDeltaResult> {
  const ops: ReadDownDeltaOp[] = [];
  let from = since;
  for (let page = 0; page < DELTA_MAX_PAGES; page += 1) {
    const deviceToken = await deps.sendableToken();
    if (deviceToken === null) return { kind: 'failed' };
    const result = await fetchDeltaPage(deps, deviceToken, from);
    if (result.kind !== 'ok') return { kind: result.kind };
    ops.push(...result.page.ops);
    if (result.page.nextPageToken === null) {
      return { kind: 'ok', cursor: result.page.cursor, ops };
    }
    if (result.page.cursor === from) return { kind: 'failed' };
    from = result.page.cursor;
  }
  return { kind: 'snapshot_required' };
}

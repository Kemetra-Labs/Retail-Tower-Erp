/**
 * RT-1441 (U2): the client-side gates and tables of the store deletion. Pure, no React.
 *
 * These only decide whether the control is SHOWN (D1: the owner only, never inside a support
 * session) and which catalog key a server code reads as. The Console never grants more than the
 * server contract and never judges a store itself: the verdict (`canDelete`), the blockers and the
 * effects are the server's. The links are navigation only: each blocker names the screen that
 * clears it (A1 close without a count, retire the device, finish the count).
 */
import type { MessageKey } from "@/i18n";
import type { StoreDeletionPreview } from "@/lib/store-deletion-queries";

/** The contract's `reason` bound (1 to 200 characters). */
export const REASON_MAX = 200;

export function canDeleteStore(
  roleCode: string | null | undefined,
  inSupportSession: boolean,
): boolean {
  return !inSupportSession && roleCode === "owner";
}

export function reasonProblem(raw: string): MessageKey | null {
  const reason = raw.trim();
  if (reason.length === 0) return "storeDeletion.reason.required";
  return reason.length > REASON_MAX ? "storeDeletion.reason.tooLong" : null;
}

/** The reason field's problem while it is being typed: an empty field is not flagged yet. */
export function reasonFieldProblem(raw: string): MessageKey | undefined {
  return raw === "" ? undefined : (reasonProblem(raw) ?? undefined);
}

export interface CommitState {
  /** The server's verdict from the latest preview (`canDelete`). */
  canDelete: boolean;
  reason: string;
  /** The re-entered password: present, never judged here (the server does). */
  password: string;
  pending: boolean;
  /** The preview is being read again (after a stale or blocked answer): wait for it. */
  fetching: boolean;
}

/** The commit button is enabled only when every input the server's contract needs is present. */
export function commitReady({
  canDelete,
  reason,
  password,
  pending,
  fetching,
}: CommitState): boolean {
  return canDelete && password !== "" && !pending && !fetching && reasonProblem(reason) === null;
}

/** Effect codes the contract names (`StoreDeletionPreview.effects`), one catalog key each. */
const WILL_CHANGE: Readonly<Record<string, MessageKey>> = {
  store_hidden_from_lists: "storeDeletion.effect.willChange.store_hidden_from_lists",
  devices_refused_immediately: "storeDeletion.effect.willChange.devices_refused_immediately",
  offer_packs_rebuilt: "storeDeletion.effect.willChange.offer_packs_rebuilt",
  single_store_members_lose_access:
    "storeDeletion.effect.willChange.single_store_members_lose_access",
  count_readiness_excludes_store: "storeDeletion.effect.willChange.count_readiness_excludes_store",
  inventory_activation_excludes_store:
    "storeDeletion.effect.willChange.inventory_activation_excludes_store",
};

const WILL_NOT_CHANGE: Readonly<Record<string, MessageKey>> = {
  sales_unchanged: "storeDeletion.effect.willNotChange.sales_unchanged",
  shifts_unchanged: "storeDeletion.effect.willNotChange.shifts_unchanged",
  stock_movements_unchanged: "storeDeletion.effect.willNotChange.stock_movements_unchanged",
  erp_documents_unchanged: "storeDeletion.effect.willNotChange.erp_documents_unchanged",
  warehouse_mapping_kept: "storeDeletion.effect.willNotChange.warehouse_mapping_kept",
};

type EffectList = "willChange" | "willNotChange";

function effectTable(list: EffectList): Readonly<Record<string, MessageKey>> {
  return list === "willChange" ? WILL_CHANGE : WILL_NOT_CHANGE;
}

/** The server's effect list as catalog keys, in its order. A code this build does not know is dropped, never shown raw. */
export function effectKeys(list: EffectList, codes: readonly string[]): MessageKey[] {
  const table = effectTable(list);
  return codes.filter((c) => Object.hasOwn(table, c)).map((c) => table[c]);
}

/** True when the server lists an effect code this build has no copy for: the dialog says so instead of hiding it. */
export function hasUnknownEffect(list: EffectList, codes: readonly string[]): boolean {
  const table = effectTable(list);
  return codes.some((c) => !Object.hasOwn(table, c));
}

const CAVEATS: Readonly<Record<string, MessageKey>> = {
  offline_facts_not_visible: "storeDeletion.caveat.offline_facts_not_visible",
  queue_as_of_last_heartbeat: "storeDeletion.caveat.queue_as_of_last_heartbeat",
};

/** One catalog key per distinct caveat; a code this build does not know reads as a generic limit. */
export function caveatKeys(codes: readonly string[]): MessageKey[] {
  const keys = codes.map((c) =>
    Object.hasOwn(CAVEATS, c) ? CAVEATS[c] : ("storeDeletion.caveat.unknown" as const),
  );
  return [...new Set(keys)];
}

/** The blocker codes the contract names (`StoreDeletionBlocker`), each with its own plural catalog key. */
const BLOCKER_KEYS: Readonly<Record<string, MessageKey>> = {
  store_has_open_shift: "storeDeletion.blocker.store_has_open_shift",
  store_has_unretired_device: "storeDeletion.blocker.store_has_unretired_device",
  store_device_queue_unsynced: "storeDeletion.blocker.store_device_queue_unsynced",
  store_has_open_count_session: "storeDeletion.blocker.store_has_open_count_session",
};

/**
 * One blocker as the server sent it: `code` is a string here, not the contract's enum, because a
 * newer server may name a guard this build does not know (it then reads as `unknown`).
 */
export interface BlockerEntry {
  code: string;
  count: number;
}

export type BlockerLink =
  | { kind: "shifts"; to: string }
  /** `label` is null for a till with no name: the dialog says so. */
  | { kind: "device"; to: string; label: string | null }
  | { kind: "count"; to: string; index: number };

export interface BlockerRow {
  /** The code the row reads (the unknown ones share `unknown`). */
  code: string;
  messageKey: MessageKey;
  count: number;
  links: BlockerLink[];
}

type PreviewDevice = StoreDeletionPreview["devices"][number];

/** A till that is not retired still holds the store (`store_has_unretired_device`). */
function unretired(devices: readonly PreviewDevice[]): PreviewDevice[] {
  return devices.filter((d) => d.trustState !== "retired");
}

/** A queue that is unknown (never reported) or holds anything is not synced, never read as zero. */
function queueUnsynced(d: PreviewDevice): boolean {
  const q = d.queue;
  return q === null || q.pending > 0 || q.deadLetter > 0 || q.held > 0;
}

function deviceLink(d: PreviewDevice): BlockerLink {
  return { kind: "device", to: `/devices/${d.deviceId}`, label: d.label };
}

function linksFor(
  code: string,
  preview: StoreDeletionPreview | undefined,
  storeId: string,
): BlockerLink[] {
  if (!preview) return [];
  switch (code) {
    case "store_has_open_shift":
      return preview.openShifts.length > 0
        ? [{ kind: "shifts", to: `/stores/${storeId}/open-shifts` }]
        : [];
    case "store_has_unretired_device":
      return unretired(preview.devices).map(deviceLink);
    case "store_device_queue_unsynced":
      return unretired(preview.devices).filter(queueUnsynced).map(deviceLink);
    case "store_has_open_count_session":
      return preview.openCountSessions.map((s, i) => ({
        kind: "count",
        to: `/inventory/stores/${storeId}/counts/${s.sessionId}`,
        index: i + 1,
      }));
    default:
      return [];
  }
}

/**
 * One row per distinct blocker, in the server's order, each with the links to its fix. An unknown
 * code never leaks: it reads as not deletable now. A blocked verdict with no usable blocker still
 * reads as a reason (UX-11.11). `preview` may be older than the blockers (a 409 answers first, then
 * the preview is read again): the links follow the preview, the reasons follow the blockers.
 */
export function blockerRows(
  blockers: readonly BlockerEntry[],
  preview: StoreDeletionPreview | undefined,
  storeId: string,
): BlockerRow[] {
  const rows: BlockerRow[] = [];
  const seen = new Set<string>();
  for (const b of blockers) {
    const known = Object.hasOwn(BLOCKER_KEYS, b.code);
    const code = known ? b.code : "unknown";
    if (seen.has(code)) continue;
    seen.add(code);
    rows.push({
      code,
      messageKey: known ? BLOCKER_KEYS[b.code] : "storeDeletion.blocker.unknown",
      count: b.count,
      links: known ? linksFor(b.code, preview, storeId) : [],
    });
  }
  return rows.length > 0
    ? rows
    : [{ code: "unknown", messageKey: "storeDeletion.blocker.unknown", count: 0, links: [] }];
}

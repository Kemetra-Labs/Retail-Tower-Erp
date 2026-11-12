/**
 * RT-1339 (RT-286 S7) — the Offer Pack kept on disk between runs.
 *
 * Only the Pack body and its ETag are stored: a restart then sends `If-None-Match`
 * (a 304 restores freshness without re-downloading) and the till knows a stored
 * offer exists, so it can say «العرض غير متاح بدون اتصال» instead of silently
 * charging the regular price. No time anchor is stored (OD-8), no secret, no
 * device token. The Pack is store-level catalogue data, not personal data.
 *
 * A JSON file beside the till database, written atomically (temp file, rename).
 * Every failure is swallowed: a missing, corrupt or unwritable file is "no stored
 * Pack", never a crash and never an offer.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { OfferPackStore, StoredOfferPack } from './offer-pack-service.js';

const FILE_NAME = 'offer-pack.json';
const FORMAT = 1;

function isStored(value: unknown): value is StoredOfferPack & { format: number } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['format'] === FORMAT &&
    typeof v['tenantId'] === 'string' &&
    typeof v['etag'] === 'string' &&
    v['body'] !== undefined
  );
}

export function createOfferPackFileStore(directory: string): OfferPackStore {
  const file = path.join(directory, FILE_NAME);
  return {
    load() {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
        return isStored(parsed)
          ? { tenantId: parsed.tenantId, etag: parsed.etag, body: parsed.body }
          : null;
      } catch {
        return null;
      }
    },
    save(entry) {
      try {
        mkdirSync(directory, { recursive: true });
        const temp = `${file}.tmp`;
        writeFileSync(temp, JSON.stringify({ format: FORMAT, ...entry }), 'utf8');
        renameSync(temp, file);
      } catch {
        // Best effort: the in-memory Pack still serves this run.
      }
    },
    clear() {
      try {
        rmSync(file, { force: true });
      } catch {
        // Nothing to clear.
      }
    },
  };
}

/** A store that keeps nothing (tests, and a till whose data folder cannot be resolved). */
export const NO_OFFER_PACK_STORE: OfferPackStore = {
  load: () => null,
  save: () => undefined,
  clear: () => undefined,
};

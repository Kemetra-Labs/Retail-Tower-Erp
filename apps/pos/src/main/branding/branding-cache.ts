/**
 * RT-475 — the local tenant branding cache (migration 0060, spec 039 FR-31,
 * FR-32, FR-35a).
 *
 * Two single-row records, each validated on every read:
 *  - the name record: tenant, pairing epoch, display name, revision, ETag and
 *    `logo_state`;
 *  - the logo record: version, presentation, warnings, the 9 renditions and a
 *    local `payload_sha256` over all of them.
 *
 * Isolation (FR-32): every record carries the pairing it was read under
 * (`tenant_id` and `paired_at`). A read under any other pairing purges both
 * records, so a re-pair (even to the same tenant: the epoch always moves up)
 * or an unpair can never show the previous tenant's logo.
 *
 * Repair (FR-35a): a record that fails validation is deleted, the other kept
 * when valid, and the next network read is unconditional (no `If-None-Match`),
 * so the server cannot keep answering 304 for a cache the POS cannot use.
 *
 * The `DatabaseHandle` is injected so tests run on sql.js.
 */

import { createHash } from 'node:crypto';

import type { DatabaseHandle } from '../db/client.js';
import {
  brandingEtag,
  readReceiptRendition,
  readScreenSet,
  readWarnings,
  type LogoWarning,
  type WireBranding,
  type WireReceiptRendition,
  type WireScreenRendition,
} from './branding-wire.js';

/**
 * The pairing a read happens under. `tenant_id` is null when only the stored
 * epoch is known (a device-revoked terminal keeps its cache, FR-32).
 */
export interface BrandingScope {
  readonly tenant_id: string | null;
  readonly paired_at: number;
}

export interface CachedName {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly revision: number;
  readonly etag: string;
  readonly logo_state: 'present' | 'none';
}

export interface CachedLogo {
  readonly version: string;
  readonly revision: number;
  readonly card: boolean;
  readonly warnings: readonly LogoWarning[];
  readonly screen: readonly WireScreenRendition[];
  readonly receipt: WireReceiptRendition;
}

export interface BrandingCacheRead {
  /** The valid name record, or null. */
  readonly name: CachedName | null;
  /** The valid logo record, or null (also null when `logo_state` is `none`). */
  readonly logo: CachedLogo | null;
  /** The ETag to send as `If-None-Match`; null → the next read is unconditional. */
  readonly conditionalEtag: string | null;
}

export interface BrandingCache {
  /** Both records as validated under `scope` (repairing or purging as needed). */
  load(scope: BrandingScope): BrandingCacheRead;
  /** Replace both records in one transaction (the old renditions go with them). */
  replace(
    scope: { tenant_id: string; paired_at: number },
    branding: WireBranding,
    at: string,
  ): void;
  /** Delete both records. */
  purge(): void;
}

interface NameRow {
  tenant_id: string;
  paired_at: number;
  tenant_display_name: string;
  revision: number;
  etag: string;
  logo_state: string;
}

interface LogoRow {
  tenant_id: string;
  revision: number;
  version: string;
  updated_at: string;
  card: number;
  warnings_json: string;
  renditions_json: string;
  payload_sha256: string;
}

interface PrepareGet<Row> {
  get(...params: unknown[]): Row | undefined;
}
interface PrepareRun {
  run(...params: unknown[]): unknown;
}

const EMPTY: BrandingCacheRead = { name: null, logo: null, conditionalEtag: null };

/** The local digest over exactly what is cached, in a fixed order (FR-31). */
export function logoPayloadDigest(input: {
  revision: number;
  version: string;
  updated_at: string;
  card: boolean;
  warnings: readonly string[];
  screen: readonly WireScreenRendition[];
  receipt: WireReceiptRendition;
}): string {
  const screen = [...input.screen]
    .sort((a, b) => (a.slot === b.slot ? a.scale - b.scale : a.slot < b.slot ? -1 : 1))
    .map((r) => [r.slot, r.scale, r.width_px, r.height_px, r.png_base64]);
  const { receipt } = input;
  const canonical = JSON.stringify([
    input.revision,
    input.version,
    input.updated_at,
    input.card,
    [...input.warnings].sort(),
    screen,
    [receipt.width_px, receipt.height_px, receipt.dpi, receipt.png_base64],
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function inScope(row: NameRow, scope: BrandingScope): boolean {
  if (row.paired_at !== scope.paired_at) return false;
  return scope.tenant_id === null || row.tenant_id === scope.tenant_id;
}

function validName(row: NameRow): CachedName | null {
  if (row.logo_state !== 'present' && row.logo_state !== 'none') return null;
  if (row.tenant_display_name.length === 0) return null;
  if (brandingEtag(row.tenant_display_name, row.revision) !== row.etag) return null;
  return {
    tenant_id: row.tenant_id,
    display_name: row.tenant_display_name,
    revision: row.revision,
    etag: row.etag,
    logo_state: row.logo_state,
  };
}

/** The cached warnings and renditions, re-read with the wire rules; null when any fails. */
function readCachedAssets(
  row: LogoRow,
): Pick<CachedLogo, 'warnings' | 'screen' | 'receipt'> | null {
  const warnings = readWarnings(parseJson(row.warnings_json));
  const renditions = parseJson(row.renditions_json);
  if (warnings === null || !isObject(renditions)) return null;
  const { screen: rawScreen, receipt: rawReceipt } = renditions;
  const screen = readScreenSet(rawScreen);
  const receipt = readReceiptRendition(rawReceipt);
  return screen === null || receipt === null ? null : { warnings, screen, receipt };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isFlag(value: number): value is 0 | 1 {
  return value === 0 || value === 1;
}

function belongsTo(row: LogoRow, name: CachedName): boolean {
  return row.tenant_id === name.tenant_id && row.revision === name.revision;
}

function validLogo(row: LogoRow, name: CachedName): CachedLogo | null {
  const assets = belongsTo(row, name) ? readCachedAssets(row) : null;
  if (assets === null || !isFlag(row.card)) return null;
  const logo: CachedLogo = {
    version: row.version,
    revision: row.revision,
    card: row.card === 1,
    ...assets,
  };
  const digest = logoPayloadDigest({ ...logo, updated_at: row.updated_at });
  return digest === row.payload_sha256 ? logo : null;
}

export function createBrandingCache(db: DatabaseHandle): BrandingCache {
  const deleteName = (): void => {
    (db.prepare('DELETE FROM tenant_branding_name') as PrepareRun).run();
  };
  const deleteLogo = (): void => {
    (db.prepare('DELETE FROM tenant_branding_logo') as PrepareRun).run();
  };
  const purge = db.transaction(() => {
    deleteName();
    deleteLogo();
  });

  const readNameRow = (): NameRow | undefined =>
    (
      db.prepare(
        `SELECT tenant_id, paired_at, tenant_display_name, revision, etag, logo_state
         FROM tenant_branding_name WHERE id = 1`,
      ) as PrepareGet<NameRow>
    ).get();

  const readLogoRow = (): LogoRow | undefined =>
    (
      db.prepare(
        `SELECT tenant_id, revision, version, updated_at, card, warnings_json,
                renditions_json, payload_sha256
         FROM tenant_branding_logo WHERE id = 1`,
      ) as PrepareGet<LogoRow>
    ).get();

  function load(scope: BrandingScope): BrandingCacheRead {
    const nameRow = readNameRow();
    const name = nameRow !== undefined && inScope(nameRow, scope) ? validName(nameRow) : null;
    if (name === null) {
      // Missing, from another pairing, or corrupt: nothing can be attributed.
      purge();
      return EMPTY;
    }
    return loadLogo(name);
  }

  /** The logo record checked against a valid name record (FR-35a). */
  function loadLogo(name: CachedName): BrandingCacheRead {
    const logoRow = readLogoRow();
    if (logoRow === undefined) {
      // `present` with no logo record: unusable, so the next read is unconditional.
      const conditionalEtag = name.logo_state === 'none' ? name.etag : null;
      return { name, logo: null, conditionalEtag };
    }
    const logo = name.logo_state === 'present' ? validLogo(logoRow, name) : null;
    if (logo === null) deleteLogo();
    // Conditional polling only while both records agree.
    return { name, logo, conditionalEtag: logo === null ? null : name.etag };
  }

  const replace = db.transaction(
    (scope: { tenant_id: string; paired_at: number }, branding: WireBranding, at: string) => {
      deleteName();
      deleteLogo();
      const { tenant_display_name: name, revision, logo } = branding;
      (
        db.prepare(
          `INSERT INTO tenant_branding_name
             (id, tenant_id, paired_at, tenant_display_name, revision, etag, logo_state, fetched_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
        ) as PrepareRun
      ).run(
        scope.tenant_id,
        scope.paired_at,
        name,
        revision,
        brandingEtag(name, revision),
        logo === null ? 'none' : 'present',
        at,
      );
      if (logo === null) return;
      const payload = {
        revision,
        version: logo.version,
        updated_at: logo.updated_at,
        card: logo.card,
        warnings: logo.warnings,
        screen: logo.screen,
        receipt: logo.receipt,
      };
      (
        db.prepare(
          `INSERT INTO tenant_branding_logo
             (id, tenant_id, revision, version, updated_at, card, warnings_json,
              renditions_json, payload_sha256)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ) as PrepareRun
      ).run(
        scope.tenant_id,
        revision,
        logo.version,
        logo.updated_at,
        logo.card ? 1 : 0,
        JSON.stringify(logo.warnings),
        JSON.stringify({ screen: logo.screen, receipt: logo.receipt }),
        logoPayloadDigest(payload),
      );
    },
  );

  return {
    load,
    replace: (scope, branding, at) => {
      replace(scope, branding, at);
    },
    purge: () => {
      purge();
    },
  };
}

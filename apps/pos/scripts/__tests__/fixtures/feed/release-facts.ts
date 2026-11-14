import { createHash } from 'node:crypto';
import { dump } from 'js-yaml';

import type { LaneState, ReleaseFacts } from '../../../feed/channel-promotion-plan';

/**
 * RT-1393 — synthetic release facts for the promotion plan tests. Every digest is computed
 * from fake bytes, so the fixtures carry no real installer, certificate or endpoint.
 */

export const LAB_PIN = 'Kemetra POS LAB TEST - NOT FOR PRODUCTION';
const PILOT_PIN = 'Kemetra POS Pilot Test Signer';
export const PROD_PIN = 'Kemetra Labs Example Production Signer';
export const EVIDENCE = 'https://rahmaqanater.atlassian.net/browse/RT-324';

type FixtureLane = 'lab' | 'pilot' | 'production';

const sha256 = (bytes: Buffer | string): string =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sha512 = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('base64');

const PRODUCT: Record<FixtureLane, string> = {
  lab: 'pos',
  pilot: 'pos-pilot',
  production: 'pos',
};
const SIGNING: Record<FixtureLane, string | undefined> = {
  lab: undefined,
  pilot: 'pilot',
  production: 'production',
};
const PIN: Record<FixtureLane, string> = { lab: LAB_PIN, pilot: PILOT_PIN, production: PROD_PIN };

function installerName(lane: FixtureLane, version: string): string {
  return lane === 'lab' ? `POS-Pulse-LAB-Setup-${version}.exe` : `POS-Pulse-Setup-${version}.exe`;
}

export function pinFor(lane: FixtureLane): string {
  return PIN[lane];
}

/** A channel file in the shape electron-builder writes (as the live lab.yml). */
export function channelYml(
  name: string,
  hash: string,
  size: number,
  extra: Record<string, unknown> = {},
): string {
  return dump(
    {
      version: extra['version'],
      files: [{ url: name, sha512: hash, size }],
      path: name,
      sha512: hash,
      releaseDate: '2026-11-14T00:00:00.000Z',
      ...extra,
    },
    { lineWidth: 8000 },
  );
}

/** A complete, consistent release of `version` for `lane`. */
export function release(lane: FixtureLane, version: string): ReleaseFacts {
  const bytes = Buffer.from(`installer ${lane} ${version}`);
  const blockmapBytes = Buffer.from(`blockmap ${lane} ${version}`);
  const name = installerName(lane, version);
  const channelFileName = 'lab.yml';
  const channelFileText = channelYml(name, sha512(bytes), bytes.length, { version });
  const product = PRODUCT[lane];
  const signing = SIGNING[lane];
  const manifest: Record<string, unknown> = {
    schema: 'retail-tower.release-manifest/v1',
    product,
    mode: 'release',
    tag: `${product}/v${version}`,
    artifacts: [
      {
        name: 'pos-blockmap',
        file: `${name}.blockmap`,
        bytes: blockmapBytes.length,
        digest: sha256(blockmapBytes),
      },
      {
        name: 'pos-channel',
        file: channelFileName,
        bytes: channelFileText.length,
        digest: sha256(channelFileText),
      },
      { name: 'pos-installer', file: name, bytes: bytes.length, digest: sha256(bytes) },
    ],
    ...(signing === undefined ? {} : { signing }),
  };
  return {
    manifest,
    channelFileName,
    channelFileText,
    installer: { name, sha256: sha256(bytes), sha512: sha512(bytes), size: bytes.length },
    blockmap: { name: `${name}.blockmap`, sha256: sha256(blockmapBytes) },
    publisher: PIN[lane],
  };
}

/** The feed state of a lane whose channels serve the given versions (all files present). */
export function laneState(
  lane: FixtureLane,
  channels: Partial<Record<'lab' | 'canary' | 'stable', string>>,
  staging: Partial<Record<'stable', number>> = {},
): LaneState {
  const files: Record<string, string> = {};
  const texts: Partial<Record<'lab' | 'canary' | 'stable', string>> = {};
  for (const [channel, version] of Object.entries(channels) as [
    'lab' | 'canary' | 'stable',
    string,
  ][]) {
    const facts = release(lane, version);
    files[facts.installer.name] = facts.installer.sha256;
    if (facts.blockmap) files[facts.blockmap.name] = facts.blockmap.sha256;
    const pct = channel === 'stable' ? staging.stable : undefined;
    texts[channel] = channelYml(
      facts.installer.name,
      facts.installer.sha512,
      facts.installer.size,
      {
        version,
        ...(pct === undefined ? {} : { stagingPercentage: pct }),
      },
    );
  }
  return { channels: texts, files };
}

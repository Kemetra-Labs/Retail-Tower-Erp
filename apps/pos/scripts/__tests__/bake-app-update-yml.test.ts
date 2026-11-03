import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { parsePublisherPins } from '../../src/main/update/update-config';

/**
 * RT-1082 — the release builds its installer with `electron-builder --prepackaged`, which never
 * runs the hook that writes `resources/app-update.yml`. bake-app-update-yml.cjs writes it instead.
 * These tests run the helper for real against the real electron-builder.lab.yml and package.json
 * and read the result with the updater's own parser, so a wrong byte is caught before a tag.
 */

interface AppUpdateConfig {
  provider: string;
  url: string;
  channel: string;
  updaterCacheDirName: string;
  publisherName: string[];
}

interface BakeHelper {
  appUpdateConfig(
    labConfig: string,
    packageJson: string,
    expectedPublisher: string,
  ): AppUpdateConfig;
  renderAppUpdateYml(config: AppUpdateConfig): string;
  bakeAppUpdateYml(
    unpackedDir: string,
    expectedPublisher: string,
    sources?: { labConfigText?: string; packageJsonText?: string },
  ): string;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const nodeRequire = createRequire(import.meta.url);
const helper = nodeRequire('../lab/ci/bake-app-update-yml.cjs') as BakeHelper;
// LF-normalised for the edits below (a Windows checkout may be CRLF); the helper itself reads either.
const LAB_CONFIG = readFileSync(
  path.join(REPO_ROOT, 'electron-builder.lab.yml'),
  'utf8',
).replaceAll('\r\n', '\n');
const PACKAGE_JSON = readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
const SIGNER = 'Kemetra POS LAB TEST - NOT FOR PRODUCTION';

// What electron-builder 26 bakes for the lab config's generic provider
// (PublishManager.getAppUpdatePublishConfiguration, serialized by builder-util serializeToYaml).
const EXPECTED = [
  'provider: generic',
  'url: https://rt772-lab.test:8443/lab',
  'channel: lab',
  'updaterCacheDirName: pos-pulse-updater',
  'publisherName:',
  '  - Kemetra POS LAB TEST - NOT FOR PRODUCTION',
  '',
].join('\n');

const temps: string[] = [];
function unpackedDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'rt1082-unpacked-'));
  temps.push(dir);
  mkdirSync(path.join(dir, 'resources'));
  writeFileSync(path.join(dir, 'resources', 'app.asar'), 'asar');
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('RT-1082 bake-app-update-yml.cjs', () => {
  it('renders exactly what electron-builder bakes for the lab config', () => {
    const text = helper.renderAppUpdateYml(
      helper.appUpdateConfig(LAB_CONFIG, PACKAGE_JSON, SIGNER),
    );
    expect(text).toBe(EXPECTED);
  });

  it('is read by the updater as exactly the lab publisher pin', () => {
    const text = helper.renderAppUpdateYml(
      helper.appUpdateConfig(LAB_CONFIG, PACKAGE_JSON, SIGNER),
    );
    expect(parsePublisherPins(text)).toEqual([SIGNER]);
  });

  it('writes resources/app-update.yml as LF UTF-8 without a BOM, outside app.asar', () => {
    const dir = unpackedDir();
    const text = helper.bakeAppUpdateYml(dir, SIGNER);
    const bytes = readFileSync(path.join(dir, 'resources', 'app-update.yml'));
    expect(bytes.toString('utf8')).toBe(EXPECTED);
    expect(text).toBe(EXPECTED);
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.includes('\r')).toBe(false);
    expect(readFileSync(path.join(dir, 'resources', 'app.asar'), 'utf8')).toBe('asar');
  });

  it('accepts an identical existing file and refuses one with other content', () => {
    const dir = unpackedDir();
    const target = path.join(dir, 'resources', 'app-update.yml');
    writeFileSync(target, EXPECTED);
    expect(helper.bakeAppUpdateYml(dir, SIGNER)).toBe(EXPECTED);
    writeFileSync(target, EXPECTED.replace('channel: lab', 'channel: stable'));
    expect(() => helper.bakeAppUpdateYml(dir, SIGNER)).toThrow(/other content/);
  });

  it('refuses a directory that is not win-unpacked', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'rt1082-empty-'));
    temps.push(dir);
    expect(() => helper.bakeAppUpdateYml(dir, SIGNER)).toThrow(/not a win-unpacked directory/);
  });

  it('fails closed on a publisher that is not the lab signer', () => {
    expect(() =>
      helper.appUpdateConfig(LAB_CONFIG, PACKAGE_JSON, 'Kemetra POS Production'),
    ).toThrow(/not the lab signer/);
    const noPin = LAB_CONFIG.replace(/^\s+publisherName:.*\n/m, '');
    expect(() => helper.appUpdateConfig(noPin, PACKAGE_JSON, SIGNER)).toThrow(
      /win\.signtoolOptions\.publisherName/,
    );
  });

  it('fails closed on a publish entry it cannot reproduce', () => {
    const cases: Array<[string, RegExp]> = [
      [LAB_CONFIG.replace('provider: generic', 'provider: github'), /generic provider/],
      [LAB_CONFIG.replace(/^\s+url:.*\n/m, ''), /no publish url/],
      [LAB_CONFIG.replace(/^\s+channel:.*\n/m, ''), /no publish channel/],
      [
        LAB_CONFIG.replace('channel: lab', 'channel: lab\n    useMultipleRangeRequest: false'),
        /does not bake/,
      ],
      [LAB_CONFIG.replace('https://rt772-lab.test', 'http://rt772-lab.test'), /not https/],
      [LAB_CONFIG.replace('/lab\n', '/${channel}\n'), /macro/],
      [LAB_CONFIG.replace(/^publish:[\s\S]*?(?=^nsis:)/m, ''), /exactly one publish entry/],
    ];
    for (const [config, error] of cases) {
      expect(() => helper.appUpdateConfig(config, PACKAGE_JSON, SIGNER)).toThrow(error);
    }
    expect(() =>
      helper.appUpdateConfig(LAB_CONFIG, JSON.stringify({ name: '@scope/Pos' }), SIGNER),
    ).toThrow(/package\.json name/);
  });
});

'use strict';

/**
 * RT-1082 — bake `resources/app-update.yml` into a prepackaged `win-unpacked` directory.
 *
 * electron-builder writes `app-update.yml` from its PublishManager onAfterPack handler, which runs
 * inside PlatformPackager.doPack. With `--prepackaged`, doPack returns early, so a release built
 * from the prebuilt `win-unpacked` would ship WITHOUT the file. The POS updater reads its publisher
 * pin from `process.resourcesPath/app-update.yml` (update-config.ts `readPublisherPins`) and refuses
 * to run without one, so every such release could never auto-update.
 *
 * This writes exactly what electron-builder 26 bakes for the lab config's `generic` provider
 * (app-builder-lib out/publish/PublishManager.js `getAppUpdatePublishConfiguration`):
 *   { ...publish[0], updaterCacheDirName: `${sanitized package name lower-cased}-updater`,
 *     publisherName: asArray(win.signtoolOptions.publisherName) }
 * serialized by builder-util's own `serializeToYaml` (js-yaml dump, lineWidth 8000). The values are
 * read from electron-builder.lab.yml and package.json, never restated here. The file sits outside
 * app.asar, so the Electron fuses and the asar integrity are unaffected.
 *
 * Fail closed: a publish entry that is not exactly one `generic` provider with a url and a channel,
 * a publisher other than the expected signer, or an existing file with other content is refused.
 *
 * CLI (release-lab-installer.ps1): node bake-app-update-yml.cjs <win-unpacked dir> <expected publisher>
 */

const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { load } = require('js-yaml');
const { serializeToYaml } = require('builder-util');

const POS_ROOT = path.resolve(__dirname, '..', '..', '..');
const LAB_CONFIG = path.join(POS_ROOT, 'electron-builder.lab.yml');
const PACKAGE_JSON = path.join(POS_ROOT, 'package.json');
// The keys electron-builder copies from a generic publish entry that this script knows how to bake.
const PUBLISH_KEYS = ['provider', 'url', 'channel'];

function requireText(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`electron-builder.lab.yml has no ${label}`);
  }
  // electron-builder would expand a ${macro}; this script does not, so it refuses one.
  if (value.includes('${')) throw new Error(`electron-builder.lab.yml ${label} contains a macro`);
  return value;
}

/** The object electron-builder would serialize into app-update.yml for the lab config. */
function appUpdateConfig(labConfigText, packageJsonText, expectedPublisher) {
  const config = load(labConfigText);
  const publish = config === null || typeof config !== 'object' ? undefined : config.publish;
  if (!Array.isArray(publish) || publish.length !== 1) {
    throw new Error('electron-builder.lab.yml must have exactly one publish entry');
  }
  const entry = publish[0];
  if (entry === null || typeof entry !== 'object' || entry.provider !== 'generic') {
    throw new Error('electron-builder.lab.yml publish entry must be the generic provider');
  }
  const extra = Object.keys(entry).filter((key) => !PUBLISH_KEYS.includes(key));
  if (extra.length > 0) {
    throw new Error(
      `electron-builder.lab.yml publish entry has keys this script does not bake: ${extra.join(', ')}`,
    );
  }
  const url = requireText(entry.url, 'publish url');
  if (!url.startsWith('https://'))
    throw new Error('electron-builder.lab.yml publish url is not https');
  const channel = requireText(entry.channel, 'publish channel');

  const win = config.win;
  const signtool = win !== null && typeof win === 'object' ? win.signtoolOptions : undefined;
  const publisher =
    signtool !== null && typeof signtool === 'object' ? signtool.publisherName : undefined;
  requireText(publisher, 'win.signtoolOptions.publisherName');
  if (publisher !== expectedPublisher) {
    throw new Error(
      `electron-builder.lab.yml publisherName '${publisher}' is not the lab signer '${expectedPublisher}'`,
    );
  }

  const name = JSON.parse(packageJsonText).name;
  // A plain npm name is its own sanitized file name, so `${name}-updater` is what AppInfo derives.
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) {
    throw new Error('package.json name is not a plain lower-case npm name');
  }

  // Key order as electron-builder builds it: the publish entry, then the cache dir, then the pin.
  return {
    provider: 'generic',
    url,
    channel,
    updaterCacheDirName: `${name}-updater`,
    publisherName: [publisher],
  };
}

function renderAppUpdateYml(config) {
  return serializeToYaml(config);
}

/** Writes <unpacked>/resources/app-update.yml (LF, UTF-8 without BOM) and returns its text. */
function bakeAppUpdateYml(unpackedDir, expectedPublisher, sources = {}) {
  const labConfigText = sources.labConfigText ?? readFileSync(LAB_CONFIG, 'utf8');
  const packageJsonText = sources.packageJsonText ?? readFileSync(PACKAGE_JSON, 'utf8');
  const text = renderAppUpdateYml(
    appUpdateConfig(labConfigText, packageJsonText, expectedPublisher),
  );
  const resources = path.join(unpackedDir, 'resources');
  if (!existsSync(path.join(resources, 'app.asar'))) {
    throw new Error(
      `${unpackedDir} is not a win-unpacked directory (resources/app.asar is missing)`,
    );
  }
  const target = path.join(resources, 'app-update.yml');
  if (existsSync(target)) {
    if (readFileSync(target, 'utf8') !== text) {
      throw new Error('win-unpacked already has a resources/app-update.yml with other content');
    }
    return text;
  }
  writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' });
  return text;
}

module.exports = { appUpdateConfig, renderAppUpdateYml, bakeAppUpdateYml };

if (require.main === module) {
  const [unpackedDir, expectedPublisher] = process.argv.slice(2);
  try {
    if (!unpackedDir || !expectedPublisher) {
      throw new Error('usage: bake-app-update-yml.cjs <win-unpacked dir> <expected publisher>');
    }
    bakeAppUpdateYml(unpackedDir, expectedPublisher);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

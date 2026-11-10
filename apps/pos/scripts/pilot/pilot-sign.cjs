'use strict';

/**
 * RT-1294 — electron-builder `win.signtoolOptions.sign` hook for the PILOT installer only (referenced from
 * electron-builder.pilot.yml, never from the shipped or the lab config).
 *
 * It signs one file with signtool, using the pilot leaf that already sits in the CurrentUser\My store of an
 * ephemeral CI runner. It refuses any certificate whose subject is not exactly the pilot subject, always
 * adds an RFC 3161 timestamp, and never imports a certificate into any store.
 *
 *   POS_PILOT_CERT_SHA1   required  thumbprint of the pilot leaf certificate
 *   POS_PILOT_TSA_URL     required  RFC 3161 timestamp URL, http:// (the workflow's Sectigo URL) or https:// (a signature is never left untimestamped)
 *   POS_PILOT_SIGNTOOL    optional  path to signtool.exe (default: newest Windows SDK x64)
 */

const { execFileSync } = require('node:child_process');
const { existsSync, readdirSync } = require('node:fs');
const path = require('node:path');

const {
  assertPilotSubject,
  buildSigntoolArgs,
  normalizeThumbprint,
} = require('./pilot-sign-lib.cjs');

const SDK_BIN = String.raw`C:\Program Files (x86)\Windows Kits\10\bin`;

// An absolute path: `powershell.exe` resolved through PATH could be a planted binary.
const POWERSHELL = path.join(
  process.env.SystemRoot ?? String.raw`C:\Windows`,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);

/**
 * The signtool.exe to run: POS_PILOT_SIGNTOOL when set, else the newest Windows SDK x64 one.
 * @returns {string} the path of signtool.exe
 */
function findSigntool() {
  const fromEnv = process.env.POS_PILOT_SIGNTOOL;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`POS_PILOT_SIGNTOOL does not exist: ${fromEnv}`);
    return fromEnv;
  }
  const versions = existsSync(SDK_BIN)
    ? readdirSync(SDK_BIN)
        .filter((v) => v.startsWith('10.'))
        .sort()
        .reverse()
    : [];
  for (const version of versions) {
    const candidate = path.join(SDK_BIN, version, 'x64', 'signtool.exe');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('signtool.exe not found: install the Windows SDK or set POS_PILOT_SIGNTOOL');
}

let verifiedThumbprint;

/**
 * Reads the subject through the .NET store API rather than the `Cert:` drive: electron-builder runs this
 * hook with a cleared PSModulePath, under which the certificate provider (and so `Cert:`) does not load.
 * The thumbprint is validated as 40 hex characters before it reaches the command line.
 * @param {string} thumbprint a normalized 40-hex thumbprint
 * @returns {string} the subject of the certificate in CurrentUser\My
 */
function certificateSubject(thumbprint) {
  const script =
    "$s = New-Object System.Security.Cryptography.X509Certificates.X509Store('My','CurrentUser'); " +
    "$s.Open('ReadOnly'); " +
    `$c = $s.Certificates.Find('FindByThumbprint','${thumbprint}',$false); $s.Close(); ` +
    'if ($c.Count -ne 1) { exit 3 }; $c[0].Subject';
  try {
    return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    }).trim();
  } catch {
    throw new Error(String.raw`pilot certificate ${thumbprint} not found in Cert:\CurrentUser\My`);
  }
}

/** @param {{ path: string }} configuration */
module.exports = async function pilotSign(configuration) {
  const thumbprint = normalizeThumbprint(process.env.POS_PILOT_CERT_SHA1);
  if (verifiedThumbprint !== thumbprint) {
    assertPilotSubject(certificateSubject(thumbprint));
    verifiedThumbprint = thumbprint;
  }
  const args = buildSigntoolArgs({
    thumbprint,
    file: configuration.path,
    tsaUrl: process.env.POS_PILOT_TSA_URL,
  });
  execFileSync(findSigntool(), args, { stdio: 'inherit' });
};

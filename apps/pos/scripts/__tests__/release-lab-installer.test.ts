import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RT-1082 — static guard for the CI script that turns a prebuilt `win-unpacked` directory into
 * the lab-signed per-user installer inside a `pos/vX.Y.Z` tag run.
 *
 * The script is never executed here: it installs certificates, trusts a root in
 * LocalMachine\Root and silently installs the app, which only an ephemeral runner may do. These
 * tests pin the properties the release relies on: the installer is built from the prepackaged
 * app, no key can leave the runner, the pinned root is the only trust added, a wrong PFX fails
 * closed, and the installer, `lab.yml` and the installed files are all checked before anything
 * is handed to the next step.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = 'scripts/lab/ci/release-lab-installer.ps1';
// Line endings are normalised: a Windows checkout with `core.autocrlf=true` writes CRLF.
const script = existsSync(path.join(REPO_ROOT, SCRIPT))
  ? readFileSync(path.join(REPO_ROOT, SCRIPT), 'utf8').replaceAll('\r\n', '\n')
  : '';

/** Body of a top-level `function Name { ... }`: every function in the script closes at column 0. */
function functionBody(name: string): string {
  const match = new RegExp(String.raw`^function ${name}\b[^\n]*\{\n([\s\S]*?)\n\}$`, 'm').exec(
    script,
  );
  return match?.[1] ?? '';
}

// Each Import-PfxCertificate call, including its backtick-continued lines.
const pfxImports = script.match(/Import-PfxCertificate(?:[^\n]*`\n)*[^\n]*/g) ?? [];

describe('RT-1082 release-lab-installer.ps1', () => {
  it('exists', () => {
    expect(script).not.toBe('');
  });

  it('builds the installer from the prepackaged app with the lab config, never publishing', () => {
    expect(script).toMatch(/electron-builder\b[^\n]*--win nsis/);
    expect(script).toMatch(/--config electron-builder\.lab\.yml/);
    expect(script).toMatch(/--prepackaged/);
    expect(script).toMatch(/--publish never/);
    // With a prepackaged app the version comes from package.json; it is checked, not overridden.
    expect(script).not.toMatch(/extraMetadata/);
  });

  it('imports the leaf non-exportable and never exports a key', () => {
    expect(pfxImports.length).toBeGreaterThan(0);
    for (const call of pfxImports) expect(call).not.toMatch(/-Exportable/);
    expect(script).not.toMatch(/Export-PfxCertificate|Export-Certificate/);
    expect(script).not.toMatch(/\.Export\(/);
    // The PFX bytes only ever exist under RUNNER_TEMP and are deleted in a finally.
    expect(script).toMatch(/\$work = Join-Path \$env:RUNNER_TEMP /);
    expect(script).toMatch(/\$pfxPath = Join-Path \$work /);
    const writes = [...script.matchAll(/WriteAllBytes\(([^,]+),/g)].map((m) => m[1]);
    expect(writes.length).toBeGreaterThan(0);
    for (const target of writes) expect(target).toBe('$pfxPath');
    expect(script).toMatch(/finally \{[\s\S]*Remove-Item[^\n]*\$pfxPath/);
  });

  it('never prints a password, the PFX bytes or base64', () => {
    const printed = script
      .split('\n')
      .filter((line) => /Write-Host|Write-Output|Write-Error/.test(line));
    for (const line of printed) {
      expect(line).not.toMatch(
        /PFX_BASE64|PFX_PASSWORD|\$pfxBytes|\$password|ToBase64String\(\$pfx/,
      );
    }
    // The secrets are read once and removed from the environment before any child process runs.
    expect(script).toMatch(/Remove-Item "Env:\$name"/);
    expect(script).toMatch(/'POS_LAB_SIGN_PFX_BASE64', 'POS_LAB_SIGN_PFX_PASSWORD'/);
  });

  it('refuses a leaf that is not the lab subject or expires within 30 days', () => {
    const release = functionBody('Initialize-ReleaseCertificate');
    expect(script).toMatch(/\$marker = 'LAB TEST - NOT FOR PRODUCTION'/);
    expect(release).toMatch(/\.Subject -ne \$leafSubject/);
    expect(release).toMatch(/NotAfter -lt \(Get-Date\)\.AddDays\(30\)/);
    // The call sites in the main block, not the function definitions above it.
    const build = script.indexOf('npx electron-builder');
    expect(build).toBeGreaterThan(0);
    expect(script.indexOf('Initialize-ReleaseCertificate $ctx')).toBeLessThan(build);
  });

  it('fails closed when the PFX does not contain the pinned root', () => {
    const release = functionBody('Initialize-ReleaseCertificate');
    expect(release).toMatch(/\$env:POS_LAB_ROOT_SHA1/);
    // The pin is validated as 40 hex characters, then the root is found by exactly that
    // thumbprint: whatever other root happens to be in the PFX is never trusted.
    expect(release).toMatch(/\[0-9A-F\]\{40\}/);
    expect(release).toMatch(/Thumbprint -eq \$pinnedRoot/);
    expect(release).toMatch(/throw[^\n]*does not contain the pinned root/);
    expect(release).toMatch(/Subject -ne \$rootSubject/);
    // The refusal happens before the root is added to any trust store.
    expect(release.indexOf('does not contain the pinned root')).toBeLessThan(
      release.indexOf('Add-RootTrust'),
    );
    expect(release.indexOf('does not contain the pinned root')).toBeLessThan(
      release.indexOf('Import-PfxCertificate'),
    );
  });

  it('trusts only the pinned public root, only for verification, and removes it', () => {
    const trust = functionBody('Add-RootTrust');
    expect(trust).toMatch(/X509Store\('Root', 'LocalMachine'\)/);
    // Public bytes only: the trusted object is rebuilt from RawData, never the PFX entry.
    expect(trust).toMatch(/RawData/);
    expect(script).not.toMatch(/TrustedPublisher|CurrentUser\\Root|'AuthRoot'/);
    // The release root is trusted through the one pinned thumbprint, nothing else.
    expect(functionBody('Initialize-ReleaseCertificate')).toMatch(/Add-RootTrust \$root\b/);
    // `-Cleanup` removes the root again, plus everything the PFX import put in the user store.
    const cleanup = functionBody('Remove-LabTrust');
    expect(cleanup).toMatch(/Cert:\\LocalMachine\\Root\\\$/);
    expect(cleanup).toMatch(/Cert:\\CurrentUser\\My\\\$/);
    expect(script).toMatch(/if \(\$Cleanup\) \{ Remove-LabTrust; exit 0 \}/);
    // The chain is checked against the trusted root before signing starts.
    expect(script).toMatch(/Assert-LeafChain/);
  });

  it('uses an ephemeral certificate in dry-run and reads no signing variable', () => {
    const dryRun = functionBody('Initialize-DryRunCertificate');
    expect(dryRun).toMatch(/new-lab-signing-cert\.ps1/);
    expect(dryRun).toMatch(/-LeafDays 2 -RootDays 3/);
    // The ephemeral pair never touches the default D:\ output of that script.
    expect(dryRun).toMatch(/-OutDir \$certDir/);
    expect(script).toMatch(/\$certDir = Join-Path \$work /);
    expect(dryRun).not.toMatch(/POS_LAB_SIGN_|POS_LAB_ROOT_SHA1/);
  });

  it('clears every production signing variable', () => {
    for (const name of [
      'CSC_LINK',
      'CSC_KEY_PASSWORD',
      'CSC_NAME',
      'WIN_CSC_LINK',
      'WIN_CSC_KEY_PASSWORD',
    ]) {
      expect(script).toContain(`'${name}'`);
    }
    // Cleared before any certificate work or build.
    expect(script.indexOf("'WIN_CSC_KEY_PASSWORD'")).toBeLessThan(
      script.indexOf('Initialize-ReleaseCertificate $'),
    );
  });

  it('signs the prepackaged executable itself when electron-builder will not', () => {
    // electron-builder does not sign a prepackaged app's executable (C-6 fallback).
    expect(script).toMatch(/POS Pulse\.exe/);
    expect(script).toMatch(/lab-sign\.cjs/);
    const build = script.indexOf('npx electron-builder');
    expect(script.indexOf('Sign-PrepackagedExe $Unpacked')).toBeLessThan(build);
    expect(script.indexOf('Sign-PrepackagedExe $Unpacked')).toBeGreaterThan(0);
  });

  it('checks signatures, the channel file and the installed files', () => {
    expect(script).toMatch(/Get-AuthenticodeSignature/);
    expect(script).toMatch(/\$signerCn = 'Kemetra POS LAB TEST - NOT FOR PRODUCTION'/);
    expect(script).toMatch(/-ceq \$signerCn/);
    expect(script).toMatch(/Status -ne 'Valid'/);
    expect(script).toMatch(/SHA512/);
    expect(script).toMatch(/ToBase64String/);
    expect(script).toMatch(/lab\.yml/);
    expect(script).toMatch(/\$installerName\.blockmap/);
    expect(script).toMatch(/ArgumentList '\/S'/);
    expect(script).toContain('Uninstall POS Pulse.exe');
    expect(script).toContain('POS Pulse.exe');
    expect(script).toMatch(/package\.json/);
  });

  it('hands over exactly the installer, its blockmap and lab.yml', () => {
    expect(script).toMatch(/POS-Pulse-LAB-Setup-\$Version\.exe/);
    expect(script).toMatch(/\[ValidateSet\('release', 'dry-run'\)\]/);
    expect(script).toMatch(/Copy-Item[^\n]*\$Out/);
  });
});

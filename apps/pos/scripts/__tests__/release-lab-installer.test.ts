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

  it('imports only the leaf, non-exportable, through the store API, and never exports a key', () => {
    const release = functionBody('Initialize-ReleaseCertificate');
    // No whole-PFX import: the PFX's root must never land in any store, and no PKI compat layer.
    expect(script).not.toMatch(/Import-PfxCertificate/);
    expect(release).toMatch(
      /X509Store\]::new\('My', 'CurrentUser'\)[\s\S]*\$userStore\.Add\(\$leafToStore\)/,
    );
    // A persisted key without the exportable flag.
    expect(release).toMatch(/X509KeyStorageFlags\]::PersistKeySet/);
    expect(script).not.toMatch(/-Exportable|::Exportable/);
    expect(script).not.toMatch(/Export-PfxCertificate|Export-Certificate/);
    expect(script).not.toMatch(/\.Export\(/);
    // Only the one certificate with a private key is stored; its thumbprint is recorded first.
    expect(release).toMatch(/\$_\.HasPrivateKey -and \$_\.Thumbprint -eq \$leaf\.Thumbprint/);
    expect(release.indexOf("Register-Thumbprint 'userStore'")).toBeGreaterThan(0);
    expect(release.indexOf("Register-Thumbprint 'userStore'")).toBeLessThan(
      release.indexOf('$userStore.Add('),
    );
    // The PFX bytes are never written to disk; the work directory sits under RUNNER_TEMP.
    expect(script).not.toMatch(/WriteAllBytes|\.pfx|\$pfxPath|Set-Content[^\n]*\$pfxBytes/);
    expect(script).toMatch(/\$work = Join-Path \$env:RUNNER_TEMP /);
  });

  it('never prints the PFX, its base64 or its password on any output path', () => {
    // The variables that hold secret material in Initialize-ReleaseCertificate.
    const secretVar = /\$(?:encoded|secret|pfxBytes)\b/;
    // Every line that touches them, exactly: reading the environment, the presence check, the
    // decode and the two in-memory imports. A new use (an output, a log, a string) fails here.
    const allowed = new Set([
      '$encoded = $env:POS_LAB_SIGN_PFX_BASE64',
      '$secret = $env:POS_LAB_SIGN_PFX_PASSWORD',
      "if (-not $encoded -or -not $secret) { throw 'release mode needs POS_LAB_SIGN_PFX_BASE64 and POS_LAB_SIGN_PFX_PASSWORD' }",
      '$pfxBytes = [Convert]::FromBase64String($encoded)',
      '$all.Import($pfxBytes, $secret, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)',
      '$persisted.Import($pfxBytes, $secret, $persistFlags)',
    ]);
    const uses = script
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => secretVar.test(line));
    expect(new Set(uses)).toEqual(allowed);
    // No double-quoted (expanding) string anywhere interpolates them, so no Write-*, throw
    // message, string output or exception text can carry them.
    for (const literal of script.match(/"(?:[^"`\n]|`.)*"/g) ?? []) {
      expect(literal).not.toMatch(secretVar);
      expect(literal).not.toMatch(/PFX_BASE64|PFX_PASSWORD/);
    }
    // Nothing secret is written as a bare pipeline value (string output) either.
    expect(script).not.toMatch(/^\s*\$(?:encoded|secret|pfxBytes)\s*$/m);
    expect(script).not.toMatch(/ToBase64String\(\$pfx|Write-\w+[^\n]*\$env:POS_LAB_SIGN/);
    // The one catch-all prints only the exception message, which no secret can reach (above).
    expect(script).toMatch(
      /\} catch \{\n {2}Write-Host "\[FAIL\] \$\(\$_\.Exception\.Message\)"\n {2}exit 1\n\}/,
    );
    // The only PowerShell catch block (the node -e one-liner's `.catch(` is JavaScript).
    expect(script.match(/\}\s*catch\s*\{/g)).toHaveLength(1);
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
    // The release root is new-lab-release-cert.ps1's subject (RELEASE ROOT), not the dry-run
    // helper's `... ROOT`: expecting the wrong literal would make every release fail.
    expect(release).toContain("'CN=Kemetra POS LAB TEST - NOT FOR PRODUCTION RELEASE ROOT'");
    expect(release).toMatch(/Subject -ne \$releaseRootSubject/);
    expect(release).not.toMatch(/\$rootSubject/);
    // The refusal happens before the root is added to any trust store or the leaf is stored.
    expect(release.indexOf('does not contain the pinned root')).toBeLessThan(
      release.indexOf('Add-RootTrust'),
    );
    expect(release.indexOf('does not contain the pinned root')).toBeLessThan(
      release.indexOf('PersistKeySet'),
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
    expect(cleanup).toMatch(/Cert:\\LocalMachine\\Root\\\$t" \}/);
    // The user-store leaf goes with its persisted key container; the public root has no key.
    expect(cleanup).toMatch(/Cert:\\CurrentUser\\My\\\$t" -DeleteKey \}/);
    expect(cleanup).not.toMatch(/LocalMachine\\Root\\\$t" -DeleteKey/);
    const remove = functionBody('Remove-LabCertificate');
    expect(remove).toMatch(
      /if \(\$DeleteKey\) \{ Remove-Item -LiteralPath \$path -DeleteKey -Force/,
    );
    // If the key removal fails, the certificate is still removed.
    expect(remove).toMatch(
      /if \(Test-Path -LiteralPath \$path\) \{ Remove-Item -LiteralPath \$path -Force/,
    );
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
    // The install directory is read from the HKCU Uninstall key, never assumed. electron-builder's
    // NSIS template writes no InstallLocation there (installer.nsh writes it under
    // Software\<APP_GUID>), so it is the parent of the quoted UninstallString, as in run-lab-spike.ps1.
    const location = functionBody('Get-InstallLocation');
    expect(location).toMatch(/HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);
    expect(location).toMatch(/\$_\.DisplayVersion -eq \$expectedVersion -and \$_\.UninstallString/);
    expect(location).toContain(`[regex]::Match([string]$entry.UninstallString, '^"([^"]+)"')`);
    expect(location).toMatch(/throw[^\n]*not a quoted executable path/);
    expect(location).toMatch(/Split-Path -Parent \$uninstallerPath/);
    expect(script).not.toMatch(/\.InstallLocation/);
    expect(script).not.toMatch(/'Programs'/);
    const install = functionBody('Test-SilentInstall');
    expect(install).toMatch(/\$env:LOCALAPPDATA/);
    expect(install).toMatch(/\$location\.Uninstaller -ne \$uninstaller/);
  });

  it('bakes resources\\app-update.yml before packaging, after the secrets left the environment', () => {
    // electron-builder does not write app-update.yml for a --prepackaged app, and the updater
    // refuses to run without the publisher pin it holds (update-config.ts readPublisherPins).
    const bake = functionBody('Write-AppUpdateConfig');
    expect(bake).toMatch(/bake-app-update-yml\.cjs/);
    expect(bake).toMatch(/& node \$helper \$unpackedDir \$signerCn \| Out-Host/);
    expect(bake).toMatch(/if \(\$LASTEXITCODE -ne 0\) \{ throw/);
    expect(bake).toMatch(/Assert-PublisherPin \$text/);
    expect(existsSync(path.join(REPO_ROOT, 'scripts/lab/ci/bake-app-update-yml.cjs'))).toBe(true);
    const call = script.indexOf('$appUpdateYml = Write-AppUpdateConfig $Unpacked');
    expect(call).toBeGreaterThan(0);
    // After the certificate step (which removes POS_LAB_SIGN_PFX_* from the environment, so the
    // node child inherits no secret) and before electron-builder packs the installer.
    expect(call).toBeGreaterThan(script.indexOf('Initialize-ReleaseCertificate $ctx'));
    expect(call).toBeGreaterThan(script.indexOf('Initialize-DryRunCertificate $ctx'));
    expect(call).toBeLessThan(script.indexOf('npx electron-builder'));
  });

  it('requires the installed app-update.yml to pin exactly the lab publisher', () => {
    // The pins are read as update-config.ts parsePublisherPins reads them: the first
    // `publisherName:` line, its inline value or the `- item` lines after it, unquoted.
    const pins = functionBody('Get-PublisherPins');
    expect(pins).toContain("'^publisherName:\\s*(.*)$'");
    expect(pins).toContain("'^\\s+-\\s*(.*)$'");
    expect(pins).toMatch(/if \(\$inline -ne ''\) \{ return @\(\$inline\) \}/);
    expect(pins).toMatch(/if \(-not \$item\.Success\) \{ break \}/);
    expect(functionBody('ConvertFrom-YamlScalar')).toContain(`'^(["\\x27])(.*)\\1$'`);
    const assertPin = functionBody('Assert-PublisherPin');
    expect(assertPin).toMatch(/\$pins\.Count -ne 1 -or -not \(\$pins\[0\] -ceq \$signerCn\)/);
    const installed = functionBody('Assert-InstalledAppUpdateConfig');
    expect(installed).toMatch(/Join-Path \$installDir 'resources\\app-update\.yml'/);
    expect(installed).toMatch(/throw 'the installed app has no resources\\app-update\.yml/);
    expect(installed).toMatch(/Assert-PublisherPin \$text/);
    expect(installed).toMatch(/\$text -cne \$bakedText/);
    // Checked on the installed files, before the uninstall in the finally block.
    const install = functionBody('Test-SilentInstall');
    const check = install.indexOf('Assert-InstalledAppUpdateConfig $installDir $bakedAppUpdate');
    expect(check).toBeGreaterThan(install.indexOf('try {'));
    expect(check).toBeLessThan(install.indexOf('} finally {'));
    expect(script).toMatch(/Test-SilentInstall \$installer \$ctx\.leaf \$Version \$appUpdateYml/);
  });

  it('hands over exactly the installer, its blockmap and lab.yml', () => {
    expect(script).toMatch(/POS-Pulse-LAB-Setup-\$Version\.exe/);
    expect(script).toMatch(/\[ValidateSet\('release', 'dry-run'\)\]/);
    expect(script).toMatch(/Copy-Item[^\n]*\$Out/);
  });
});

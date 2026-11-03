import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RT-1082 — static guard for the owner-run script that creates the stable lab release
 * certificate (a long-lived non-exportable root plus an exportable one-year leaf).
 *
 * The script is never executed here: it would create real certificates in the user's store.
 * These tests pin the properties CI and the lab device rely on: the root key can never leave
 * the machine, the leaf subject stays the baked publisher pin, the leaf never outlives the
 * root, and nothing is written in plain text or imported into a trust store.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = 'scripts/lab/new-lab-release-cert.ps1';
// Line endings are normalised: a Windows checkout with `core.autocrlf=true` writes CRLF.
const script = existsSync(path.join(REPO_ROOT, SCRIPT))
  ? readFileSync(path.join(REPO_ROOT, SCRIPT), 'utf8').replaceAll('\r\n', '\n')
  : '';

// Each New-SelfSignedCertificate call, including its backtick-continued lines.
const calls = script.match(/New-SelfSignedCertificate(?:[^\n]*`\n)*[^\n]*/g) ?? [];

describe('RT-1082 new-lab-release-cert.ps1', () => {
  it('exists', () => {
    expect(script).not.toBe('');
  });

  it('creates a non-exportable release root and an exportable leaf under it', () => {
    expect(calls).toHaveLength(2);
    const [rootCall, leafCall] = calls;

    expect(script).toMatch(/\$marker = 'LAB TEST - NOT FOR PRODUCTION'/);
    expect(rootCall).toMatch(/-Subject "CN=Kemetra POS \$marker RELEASE ROOT"/);
    expect(rootCall).toMatch(/-KeyExportPolicy NonExportable/);
    expect(rootCall).toMatch(/2\.5\.29\.19=\{critical\}\{text\}CA=true&pathlength=0/);
    expect(rootCall).not.toMatch(/-KeyExportPolicy Exportable\b/);

    // The leaf subject is the baked publisher pin: it must stay exactly this.
    expect(leafCall).toMatch(/-Subject "CN=Kemetra POS \$marker"/);
    expect(leafCall).toMatch(/-Type CodeSigningCert/);
    expect(leafCall).toMatch(/-KeyExportPolicy Exportable\b/);
    expect(leafCall).not.toMatch(/NonExportable/);
    expect(leafCall).toMatch(/-Signer \$root\b/);

    // Exportable appears on the leaf call only.
    expect(script.match(/-KeyExportPolicy Exportable\b/g)).toHaveLength(1);
    for (const c of calls) {
      expect(c).toMatch(/-KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256/);
    }
  });

  it('defaults to a two-year root and a one-year leaf, never past the root', () => {
    expect(script).toMatch(/\[int\]\$RootDays = 730/);
    expect(script).toMatch(/\[int\]\$LeafDays = 365/);
    expect(script).toMatch(/\$leafNotAfter = \(Get-Date\)\.AddDays\(\$LeafDays\)/);
    expect(script).toMatch(
      /if \(\$leafNotAfter -gt \$root\.NotAfter\) \{ \$leafNotAfter = \$root\.NotAfter \}/,
    );
    expect(calls[1]).toMatch(/-NotAfter \$leafNotAfter/);
  });

  it('never writes a password or imports into a trust store', () => {
    expect(script).not.toMatch(/ConvertTo-SecureString\s+-AsPlainText/i);
    expect(script).not.toMatch(/Cert:\\LocalMachine\\Root/i);
    expect(script).not.toMatch(/Cert:\\CurrentUser\\Root/i);
    expect(script).not.toMatch(/Cert:\\[A-Za-z]+\\TrustedPublisher/i);
    expect(script).not.toMatch(/Import-Certificate|Import-PfxCertificate/i);
    expect(script).not.toMatch(/-Password\s+['"]/);
    expect(script).toMatch(/Read-Host[^\n]*-AsSecureString/);
    expect(script).toMatch(/-Password \$password\b/);
  });

  it('exports the PFX with its chain and the root public only', () => {
    expect(script).toMatch(/Export-PfxCertificate[^\n]*-Cert \$leaf[^\n]*-ChainOption BuildChain/);
    expect(script).toMatch(/Export-Certificate -Cert \$root\b/);
    // The root private key is never exported.
    expect(script).not.toMatch(/Export-PfxCertificate[^\n]*-Cert \$root/);
  });

  it('reads the PFX back and refuses one without the root and the leaf, as CI would', () => {
    // CI (release-lab-installer.ps1) refuses a PFX without the pinned root; BuildChain alone
    // does not prove the root went in, so the produced file is checked here.
    expect(script).toMatch(/Get-PfxData -FilePath \$PfxPath -Password \$password/);
    expect(script).toMatch(/\$pfxData\.EndEntityCertificates/);
    expect(script).toMatch(/\$pfxData\.OtherCertificates/);
    expect(script).toMatch(/\$pfxThumbprints -contains \$root\.Thumbprint/);
    expect(script).toMatch(/\$pfxThumbprints -contains \$leaf\.Thumbprint/);
    // A bad PFX is deleted before the failure, so it cannot be uploaded by mistake.
    expect(script).toMatch(
      /Remove-Item -LiteralPath \$PfxPath -Force\n\s*throw "The exported PFX does not contain/,
    );
    const exported = script.indexOf('Export-PfxCertificate');
    const readBack = script.indexOf('Get-PfxData');
    expect(readBack).toBeGreaterThan(exported);
    expect(readBack).toBeLessThan(script.indexOf('Write-Host "POS_LAB_ROOT_SHA1'));
  });

  it('tells the owner the secret names, the variable and to delete the leaf afterwards', () => {
    expect(script).toMatch(/secret {3}POS_LAB_SIGN_PFX_BASE64 {3}= the base64 of the PFX file/);
    expect(script).toMatch(/gh secret set POS_LAB_SIGN_PFX_BASE64 --env release-pos-sign/);
    expect(script).toMatch(/secret {3}POS_LAB_SIGN_PFX_PASSWORD = the PFX password/);
    expect(script).toMatch(/variable POS_LAB_ROOT_SHA1 {9}= [^\n]*not a secret/);
    expect(script).toMatch(
      /Remove-Item Cert:\\CurrentUser\\My\\\$\(\$leaf\.Thumbprint\) -DeleteKey/,
    );
  });

  it('always creates new certificates and prints the root pin and the leaf expiry', () => {
    expect(script).not.toMatch(/Get-ChildItem/);
    expect(script).toMatch(/Write-Host "POS_LAB_ROOT_SHA1 = \$\(\$root\.Thumbprint\)"/);
    expect(script).toMatch(
      /Write-Host "leaf expires \$\(\$leaf\.NotAfter\.ToString\('yyyy-MM-dd'\)\)"/,
    );
  });
});

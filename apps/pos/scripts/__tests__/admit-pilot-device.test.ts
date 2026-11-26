import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RT-1611 (RT-1290 P5) — guards for the owner-run device admission script.
 *
 * The script makes ONE device trust ONE certificate: the pinned, self-signed pilot leaf, read from the
 * downloaded installer. These tests pin what it may write (the public leaf, LocalMachine\Root only), what it
 * checks before writing, and that it undoes a failed admission.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), 'utf8').replaceAll('\r\n', '\n');

const script = read('scripts/pilot/admit-pilot-device.ps1');
/** The script without its help block and `#` comments, so negative checks look at code only. */
const code = script.replace(/<#[\s\S]*?#>/g, '').replace(/^\s*#.*$/gm, '');
/** The process environment without PSModulePath, in whatever case Windows spelled it. */
const withoutPsModulePath = (): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'),
  );
/** Index of the first match, or -1. */
const at = (pattern: RegExp): number => script.search(pattern);

describe('RT-1611 admit-pilot-device.ps1: inputs', () => {
  it('needs the installer, the SHA-256 from Download POS and the pinned thumbprint; has VerifyOnly and Remove modes', () => {
    expect(script).toMatch(
      /\[Parameter\(Mandatory, ParameterSetName = 'Admit'\)\]\[string\]\$InstallerPath/,
    );
    expect(script).toMatch(
      /\[Parameter\(Mandatory, ParameterSetName = 'Admit'\)\]\[string\]\$ExpectedSha256/,
    );
    expect(script).toMatch(/\[Parameter\(Mandatory\)\]\[string\]\$PinnedThumbprint/);
    expect(script).toMatch(/\[switch\]\$VerifyOnly/);
    expect(script).toMatch(
      /\[Parameter\(Mandatory, ParameterSetName = 'Remove'\)\]\[switch\]\$Remove/,
    );
  });

  it('validates the pin and the hash formats before using them', () => {
    expect(script).toMatch(/\$pin -notmatch '\^\[0-9A-F\]\{40\}\$'/);
    expect(script).toMatch(/\$want -notmatch '\^\[0-9a-f\]\{64\}\$'/);
  });

  it('never interpolates a variable followed by a colon (a PowerShell drive-qualifier trap)', () => {
    const strings = script.match(/"[^"\n]*"/g) ?? [];
    for (const s of strings) {
      expect(s, s).not.toMatch(/\$[A-Za-z_]+:(?!:)/);
    }
  });
});

describe('RT-1611 admit-pilot-device.ps1: what it checks', () => {
  it('checks the file hash, an intact signature, the pin, the exact subject, self-signed, Code Signing only, not a CA, not expired', () => {
    expect(script).toMatch(/Get-FileHash -LiteralPath \$path -Algorithm SHA256/);
    expect(script).toMatch(/\$acceptedStatus = @\('Valid', 'UnknownError'\)/);
    expect(script).toMatch(/explicitly distrusted on this device/);
    // UnknownError is accepted only when the signer chain's single failure is its untrusted self-signed root.
    expect(script).toMatch(
      /if \(\[string\]\$sig\.Status -eq 'UnknownError'\) \{[\s\S]*?Assert-OnlyUntrustedRoot \$sig\.SignerCertificate/,
    );
    expect(script).toMatch(/\$reasons\[0\] -ne 'UntrustedRoot'/);
    // ...and only when Windows' reason is exactly CERT_E_UNTRUSTEDROOT, in this system's language.
    expect(script).toMatch(/Win32Exception\]::new\(\[int\]0x800B0109\)\.Message/);
    expect(script).toMatch(/SignatureType -ne 'Authenticode'/);
    expect(script).toMatch(/KeyCertSign -bor \$flags::CrlSign/);
    expect(script).toMatch(/Basic Constraints extension is not critical/);
    expect(script).toMatch(/\$leaf\.NotBefore -gt \$now/);
    expect(script).toMatch(/\$leaf\.Thumbprint -ne \$pin/);
    expect(script).toMatch(/\$pilotSubject = 'CN=Kemetra POS PILOT'/);
    expect(script).toMatch(/\$leaf\.Subject -cne \$pilotSubject/);
    expect(script).toMatch(/\$leaf\.Issuer -cne \$leaf\.Subject/);
    expect(script).toMatch(/\$codeSigningOid = '1\.3\.6\.1\.5\.5\.7\.3\.3'/);
    expect(script).toMatch(/\$purposes\.Count -ne 1/);
    expect(script).toMatch(/has no Basic Constraints extension/);
    expect(script).toMatch(/\$basic\.CertificateAuthority/);
    expect(script).toMatch(/\$leaf\.NotAfter -lt \$now/);
  });

  it('runs every check before it writes anything, and VerifyOnly exits before the write', () => {
    const write = at(/\$store\.Add\(\$leaf\)/);
    expect(write).toBeGreaterThan(0);
    for (const check of [
      /^Assert-InstallerHash \$installer/m,
      /^Assert-PilotLeaf \$leaf/m,
      /^if \(\$VerifyOnly\)/m,
      /^Assert-Elevated$/m,
    ]) {
      const i = at(check);
      expect(i, String(check)).toBeGreaterThan(0);
      expect(i, String(check)).toBeLessThan(write);
    }
  });

  it('adds only the public bytes rebuilt from the signer certificate', () => {
    expect(script).toMatch(
      /X509Certificate2\]::new\(\[byte\[\]\]\$sig\.SignerCertificate\.RawData\)/,
    );
  });
});

describe('RT-1611 admit-pilot-device.ps1: where it writes', () => {
  it('writes only to LocalMachine\\Root, never TrustedPublisher, a CurrentUser store or AuthRoot', () => {
    expect(script).toMatch(/X509Store\('Root', 'LocalMachine'\)/);
    const stores = script.match(/X509Store\([^)]*\)/g) ?? [];
    expect(stores).toEqual(["X509Store('Root', 'LocalMachine')"]);
    expect(code).not.toMatch(
      /TrustedPublisher|CurrentUser|AuthRoot|Import-Certificate|Import-PfxCertificate|certutil/i,
    );
  });

  it('serialises admission and removal with one machine-wide lock per thumbprint, taken before the presence check', () => {
    expect(script).toContain('Global\\RT1611-pilot-device-admission-$pin');
    const lockUses = script.match(/^\s*\$lock = Enter-AdmissionLock$/gm) ?? [];
    expect(lockUses.length).toBe(2);
    const presence = at(/^\s*\$already = Test-Path/m);
    expect(presence).toBeGreaterThan(0);
    expect(at(/^\$lock = Enter-AdmissionLock$/m)).toBeLessThan(presence);
    // Released and disposed in a finally on both paths, so a later run in the same session is not blocked.
    expect(script).toMatch(/\$mutex\.ReleaseMutex\(\)/);
    expect(script).toMatch(/\$mutex\.Dispose\(\)/);
    const releases = script.match(/\} finally \{\n\s*Exit-AdmissionLock \$lock\n\s*\}/g) ?? [];
    expect(releases.length).toBe(2);
  });

  it('needs an elevated shell for the write and for Remove', () => {
    expect(script).toMatch(/WindowsBuiltInRole\]::Administrator/);
    const uses = script.match(/^\s*Assert-Elevated$/gm) ?? [];
    expect(uses.length).toBe(2);
  });

  it('confirms Valid from the pinned leaf afterwards, and removes a leaf it just added when that fails', () => {
    expect(script).toMatch(
      /\[string\]\$check\.Status -ne 'Valid' -or \$check\.SignerCertificate\.Thumbprint -ne \$pin/,
    );
    // Any stop before $admitted is set (an error, Ctrl+C) removes the leaf again, in a finally block.
    expect(script).toMatch(/\$admitted = \$false\n\s*try \{/);
    expect(script).toMatch(
      /\} finally \{\n\s*if \(-not \$admitted\) \{\n\s*try \{ Remove-PilotLeaf/,
    );
    expect(script).toMatch(/ROLLBACK FAILED/);
  });

  it('Remove takes out only the pinned leaf, and refuses one with another subject', () => {
    expect(script).toMatch(/Where-Object \{ \$_\.Thumbprint -eq \$pin \}/);
    expect(script).toMatch(/is not the pilot certificate \(subject: .*\): not removing it/);
  });

  it('holds no thumbprint, hash or secret of its own', () => {
    expect(script).not.toMatch(/\b[0-9A-Fa-f]{40}\b/);
    expect(script).not.toMatch(/\b[0-9a-f]{64}\b/);
    expect(script).not.toMatch(/PFX|password|Read-Host/i);
  });
});

/**
 * Behaviour, not text: the fixture signs small files with throwaway certificates (CurrentUser\My only, deleted
 * afterwards) and runs the script with -VerifyOnly, which needs no admin and writes no trust store.
 * Windows only (the POS CI runs on windows-latest).
 */
describe.runIf(process.platform === 'win32')(
  'RT-1611 admit-pilot-device.ps1 -VerifyOnly behaviour',
  () => {
    it('passes only the pinned, self-signed, code-signing-only leaf on an intact file with the right hash', () => {
      const work = mkdtempSync(path.join(tmpdir(), 'rt1611-'));
      try {
        const run = spawnSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-NonInteractive',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            path.join(REPO_ROOT, 'scripts/__tests__/fixtures/admit-pilot-device-cases.ps1'),
            '-AdmitScript',
            path.join(REPO_ROOT, 'scripts/pilot/admit-pilot-device.ps1'),
            '-WorkDir',
            work,
          ],
          // Windows PowerShell 5.1 started from PowerShell 7 (the CI default shell) inherits a PSModulePath
          // that hides its own modules, including the Cert: drive; let it build its own.
          { encoding: 'utf8', timeout: 120_000, env: withoutPsModulePath() },
        );
        expect(run.status, run.stderr).toBe(0);
        const results = JSON.parse(run.stdout.trim().split(/\r?\n/).pop() ?? '{}') as Record<
          string,
          string
        >;
        expect(results['good']).toBe('pass');
        expect(results['pin in lower case with a copied U+200E mark']).toBe('pass');
        // The damaged file must exercise the guarded case: Windows reads UnknownError and still names the pinned signer.
        expect(results['damaged signature block: windows status']).toBe(
          'UnknownError naming the pinned signer',
        );
        const refusals: Record<string, RegExp> = {
          'same subject, another key': /not the pinned pilot leaf/,
          'wrong sha256': /SHA-256 is/,
          ca: /is a CA/,
          'code signing plus server auth': /Code Signing purpose only/,
          'wrong subject': /not the pilot certificate/,
          // Windows will not sign with a not-yet-valid certificate, so the file arrives unsigned: refused either way.
          'not valid yet': /not valid before|no intact signature/,
          unsigned: /no intact signature/,
          'changed after signing': /no intact signature|SHA-256 is/,
          'damaged signature block': /signature is invalid \(Windows says:/,
        };
        for (const [name, reason] of Object.entries(refusals)) {
          expect(results[name], name).toMatch(/^refused: /);
          expect(results[name], name).toMatch(reason);
        }
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    }, 150_000);
  },
);

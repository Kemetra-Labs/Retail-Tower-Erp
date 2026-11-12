import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RT-1294 — guards for the PILOT-signed installer path.
 *
 * The pilot installer is signed with a self-signed leaf whose subject is exactly `CN=Kemetra POS PILOT`.
 * These tests pin the boundary: the hook refuses every other certificate (lab, production, anything
 * else), a pilot signature is always timestamped, the pilot builder config can never publish
 * or bake an update feed, and the scripts never touch the lab secrets or write a password.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/** Reads a file of the POS product root with its line endings normalised: `core.autocrlf=true` writes CRLF. */
const read = (rel: string): string =>
  readFileSync(path.join(REPO_ROOT, rel), 'utf8').replaceAll('\r\n', '\n');
const nodeRequire = createRequire(import.meta.url);

interface PilotSignLib {
  PILOT_SUBJECT: string;
  assertPilotSubject(subject: unknown): void;
  normalizeThumbprint(value: string | undefined): string;
  assertTimestampUrl(url: string | undefined): string;
  buildSigntoolArgs(opts: { thumbprint: string; file: string; tsaUrl?: string }): string[];
}
const lib = nodeRequire('../pilot/pilot-sign-lib.cjs') as PilotSignLib;

const SHA1 = 'A'.repeat(40);
// http on purpose: the hosted runner's signtool rejected the https form in the RT-1294 dry run.
const TSA = 'http://timestamp.sectigo.com';

describe('RT-1294 pilot sign lib: only the pilot certificate may sign', () => {
  it('accepts exactly the pilot subject', () => {
    expect(lib.PILOT_SUBJECT).toBe('CN=Kemetra POS PILOT');
    expect(() => {
      lib.assertPilotSubject('CN=Kemetra POS PILOT');
    }).not.toThrow();
    expect(() => {
      lib.assertPilotSubject(' CN=Kemetra POS PILOT ');
    }).not.toThrow();
  });

  it.each([
    ['the lab certificate', 'CN=Kemetra POS LAB TEST - NOT FOR PRODUCTION'],
    ['a lab marker in any case', 'CN=Kemetra POS PILOT lab test'],
    ['the other lab marker', 'CN=Kemetra POS PILOT not for production'],
    ['another publisher', 'CN=Kemetra Labs'],
    ['a near miss', 'CN=Kemetra POS PILOT 2'],
    ['a different case', 'CN=KEMETRA POS PILOT'],
    ['an empty subject', ''],
  ])('refuses %s', (_label, subject) => {
    expect(() => {
      lib.assertPilotSubject(subject);
    }).toThrow(/refusing to sign/);
  });

  it('refuses a subject that is not a string', () => {
    expect(() => {
      lib.assertPilotSubject(undefined);
    }).toThrow(/refusing to sign/);
    expect(() => {
      lib.assertPilotSubject(null);
    }).toThrow(/refusing to sign/);
  });
});

describe('RT-1294 pilot sign lib: thumbprint and timestamp', () => {
  it('normalises a 40-hex thumbprint and refuses anything else', () => {
    expect(lib.normalizeThumbprint('aa bb '.repeat(1) + 'a'.repeat(36))).toBe(
      'AABB' + 'A'.repeat(36),
    );
    expect(() => lib.normalizeThumbprint(undefined)).toThrow(/POS_PILOT_CERT_SHA1/);
    expect(() => lib.normalizeThumbprint('xyz')).toThrow(/POS_PILOT_CERT_SHA1/);
    expect(() => lib.normalizeThumbprint('A'.repeat(39))).toThrow(/POS_PILOT_CERT_SHA1/);
  });

  it('requires an http(s) timestamp URL: a pilot signature is never left untimestamped', () => {
    expect(lib.assertTimestampUrl(TSA)).toBe(TSA);
    expect(lib.assertTimestampUrl(`  ${TSA}  `)).toBe(TSA);
    expect(lib.assertTimestampUrl('https://tsa.example.test')).toBe('https://tsa.example.test');
    for (const bad of [
      undefined,
      '',
      '  ',
      'http://',
      'https://',
      'ftp://x',
      'ftp://x/http://y',
      'xhttp://a',
      'timestamp.sectigo.com',
      'http://a b',
      'https://a b',
    ]) {
      expect(() => lib.assertTimestampUrl(bad)).toThrow(/POS_PILOT_TSA_URL/);
    }
  });

  it('builds a SHA-256 signtool call that always timestamps (RFC 3161, SHA-256) and signs the file last', () => {
    const args = lib.buildSigntoolArgs({ thumbprint: SHA1, file: 'C:\\x\\Setup.exe', tsaUrl: TSA });
    expect(args).toEqual([
      'sign',
      '/fd',
      'sha256',
      '/s',
      'My',
      '/sha1',
      SHA1,
      '/tr',
      TSA,
      '/td',
      'sha256',
      'C:\\x\\Setup.exe',
    ]);
  });

  it('refuses to build a call without a timestamp URL', () => {
    expect(() => lib.buildSigntoolArgs({ thumbprint: SHA1, file: 'f.exe' })).toThrow(
      /POS_PILOT_TSA_URL/,
    );
    expect(() =>
      lib.buildSigntoolArgs({ thumbprint: SHA1, file: 'f.exe', tsaUrl: 'ftp://x.test' }),
    ).toThrow(/POS_PILOT_TSA_URL/);
  });
});

describe('RT-1294 shipped and lab builder configs are untouched', () => {
  it('keeps the shipped config dir-only with no publish and no signing', () => {
    const base = read('electron-builder.yml');
    expect(base).toMatch(/target:\s*dir\b/);
    expect(base).not.toMatch(/^\s*publish:/m);
    expect(base).not.toMatch(/signtoolOptions|certificateSha1|cscLink/);
  });

  it('keeps the lab config pointed at the lab hook and the lab marker', () => {
    const lab = read('electron-builder.lab.yml');
    expect(lab).toMatch(/sign:\s*\.\/scripts\/lab\/lab-sign\.cjs/);
    expect(lab).toContain('LAB TEST - NOT FOR PRODUCTION');
    expect(lab).not.toContain('Kemetra POS PILOT');
  });
});

describe('RT-1294 electron-builder.pilot.yml', () => {
  const pilotPath = 'electron-builder.pilot.yml';
  const pilot = existsSync(path.join(REPO_ROOT, pilotPath)) ? read(pilotPath) : '';

  it('exists and extends the shipped config', () => {
    expect(pilot).not.toBe('');
    expect(pilot).toMatch(/^extends:\s*\.\/electron-builder\.yml$/m);
  });

  it('builds a per-user, non-elevating NSIS installer that never deletes app data', () => {
    expect(pilot).toMatch(/target:\s*nsis\b/);
    expect(pilot).toMatch(/oneClick:\s*true/);
    expect(pilot).toMatch(/perMachine:\s*false/);
    expect(pilot).toMatch(/allowElevation:\s*false/);
    expect(pilot).toMatch(/deleteAppDataOnUninstall:\s*false/);
  });

  it('names the installer as the registry expects: POS-Pulse-Setup-<version>.exe', () => {
    expect(pilot).toMatch(/^\s*artifactName:\s*POS-Pulse-Setup-\$\{version\}\.\$\{ext\}$/m);
  });

  it('has NO publish entry and no provider, so no update feed can ever be baked', () => {
    expect(pilot).not.toMatch(/^\s*publish:/m);
    expect(pilot).not.toMatch(/provider:/);
    expect(pilot).not.toMatch(/\burl:/);
    expect(pilot).not.toMatch(/channel:/);
    expect(pilot).not.toMatch(/token|accessKey|secretKey|bucket/i);
  });

  it('does not override the frozen identity or the fuses, and holds no key material', () => {
    expect(pilot).not.toMatch(/^appId:/m);
    expect(pilot).not.toMatch(/^productName:/m);
    expect(pilot).not.toMatch(/electronFuses/);
    expect(pilot).not.toMatch(/certificateFile|certificatePassword|cscLink|cscKeyPassword|\.pfx/i);
    expect(pilot).not.toMatch(/verifyUpdateCodeSignature:\s*false|forceCodeSigning:\s*false/);
  });

  it('names the pilot publisher and never carries a lab marker', () => {
    const match = /^\s*publisherName:\s*(.+)$/m.exec(pilot);
    expect(match?.[1]?.trim()).toBe('Kemetra POS PILOT');
    expect(pilot).not.toMatch(/LAB TEST|NOT FOR PRODUCTION/i);
  });

  it('signs through the pilot hook, which exists and is not the lab hook', () => {
    const hook = /^\s*sign:\s*(\S+)$/m.exec(pilot);
    expect(hook?.[1]).toBe('./scripts/pilot/pilot-sign.cjs');
    expect(existsSync(path.join(REPO_ROOT, 'scripts/pilot/pilot-sign.cjs'))).toBe(true);
  });
});

describe('RT-1294 pilot hook source', () => {
  const hook = read('scripts/pilot/pilot-sign.cjs');

  it('signs only through the pilot lib and never imports the lab lib', () => {
    expect(hook).toContain("require('./pilot-sign-lib.cjs')");
    expect(hook).not.toMatch(/lab-sign/);
  });

  it('reads only pilot environment names, and checks the subject before it signs', () => {
    expect(hook).toContain('POS_PILOT_CERT_SHA1');
    expect(hook).toContain('POS_PILOT_TSA_URL');
    expect(hook).not.toMatch(/RT772|POS_LAB/);
    expect(hook.indexOf('assertPilotSubject(')).toBeGreaterThan(-1);
    expect(hook.indexOf('assertPilotSubject(')).toBeLessThan(
      hook.indexOf('execFileSync(findSigntool()'),
    );
  });
});

describe('RT-1294 owner certificate script', () => {
  const cert = read('scripts/pilot/new-pilot-release-cert.ps1');

  it('creates a self-signed leaf that cannot issue: CA false, Code Signing EKU only, RSA 3072, SHA-256', () => {
    expect(cert).toContain('CN=Kemetra POS PILOT');
    expect(cert).toMatch(/2\.5\.29\.19=\{critical\}\{text\}CA=false/);
    expect(cert).toContain('1.3.6.1.5.5.7.3.3');
    expect(cert).toMatch(/-KeyLength 3072/);
    expect(cert).toMatch(/-HashAlgorithm SHA256/);
    expect(cert).not.toMatch(/CA=true|-Signer /);
  });

  it('never imports into any trust store and never writes the password', () => {
    expect(cert).not.toMatch(
      /Cert:\\LocalMachine|Import-Certificate|Import-PfxCertificate|X509Store/,
    );
    expect(cert).toMatch(/Read-Host 'PFX password' -AsSecureString/);
    expect(cert).not.toMatch(
      /Out-File|Set-Content|Add-Content|Write-Host \$plain|Write-Output \$plain/,
    );
  });

  it('encrypts the PFX with AES-256 and reads it back before anything is deleted', () => {
    expect(cert).toMatch(/Export-PfxCertificate [^\n]*-CryptoAlgorithmOption AES256_SHA256/);
    expect(cert).toMatch(/Get-PfxData -FilePath \$PfxPath -Password \$password/);
  });

  it('is not the lab script: no lab marker', () => {
    expect(cert).not.toMatch(/LAB TEST|NOT FOR PRODUCTION/);
  });
});

describe('RT-1294 CI release script', () => {
  const script = read('scripts/pilot/ci/release-pilot-installer.ps1');

  it('builds from the prepackaged app, never publishes, and removes the signing variables first', () => {
    expect(script).toMatch(/--prepackaged/);
    expect(script).toMatch(/--publish never/);
    expect(script).toMatch(/electron-builder\.pilot\.yml/);
    expect(script).toMatch(/POS_PILOT_SIGN_PFX_BASE64/);
    expect(script).toMatch(/Remove-Item "Env:\$name"/);
  });

  it('never touches the lab secrets, the lab config or the update baking', () => {
    expect(script).not.toMatch(/POS_LAB_|RT772_|electron-builder\.lab|lab-sign|bake-app-update/);
  });

  it('asserts the pilot installer ships no app-update.yml, before and after install', () => {
    expect(script).toMatch(/Assert-NoAppUpdateConfig/);
    const uses = script.match(/Assert-NoAppUpdateConfig/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(3);
    expect(script).toMatch(/resources\\app-update\.yml/);
  });

  it('verifies Valid, the exact pilot subject and a timestamp on the app, the uninstaller and the installer', () => {
    expect(script).toMatch(/Status -ne 'Valid'/);
    expect(script).toMatch(/\$signerCn = 'Kemetra POS PILOT'/);
    expect(script).toMatch(/TimeStamperCertificate/);
    expect(script).toMatch(/Assert-PilotSignature \$installer/);
    expect(script).toMatch(/Assert-PilotSignature \$app/);
    expect(script).toMatch(/Assert-PilotSignature \$uninstaller/);
  });

  it('refuses a release certificate that is not the pinned, unexpired, self-signed code-signing leaf', () => {
    expect(script).toMatch(/POS_PILOT_LEAF_SHA1/);
    expect(script).toMatch(/AddDays\(30\)/);
    expect(script).toMatch(/must hold exactly one certificate/);
    expect(script).toMatch(/is not self-signed/);
  });

  it('makes the dry-run leaf through a helper FILE, never an inline command, and re-checks its shape', () => {
    expect(script).toMatch(/powershell\.exe -NoProfile -ExecutionPolicy Bypass -File \$helper/);
    expect(script).not.toMatch(/powershell\.exe[^\n]*-Command/);
    expect(script).toMatch(/new-dry-run-leaf\.ps1/);
    expect(script).toMatch(/Assert-PilotLeafShape \$leaf/);
    const helper = read('scripts/pilot/ci/new-dry-run-leaf.ps1');
    expect(helper).toContain('CN=Kemetra POS PILOT');
    expect(helper).toMatch(/2\.5\.29\.19=\{critical\}\{text\}CA=false/);
    expect(helper).toContain('1.3.6.1.5.5.7.3.3');
    expect(helper).toMatch(/-KeyExportPolicy NonExportable/);
    expect(helper).toMatch(/AddDays\(2\)/);
    expect(helper).not.toMatch(/-Signer |CA=true|LAB TEST|NOT FOR PRODUCTION/);
  });

  it('removes every certificate it added, and the cleanup mode exists', () => {
    expect(script).toMatch(/\[switch\]\$Cleanup/);
    expect(script).toMatch(/Remove-PilotTrust/);
  });

  it('fails when a removal did not happen, instead of reporting success', () => {
    expect(script).toMatch(/throw "could not remove \$path"/);
    expect(script).toMatch(/pilot certificate cleanup failed/);
  });

  it('writes to the certificate stores on a GitHub-hosted runner only', () => {
    expect(script).toMatch(/\$env:GITHUB_ACTIONS -ne 'true'/);
    expect(script).toContain("$env:RUNNER_ENVIRONMENT -ne 'github-hosted'");
    // The guard is the first step of the release, before any certificate is created, imported or trusted.
    const release = script.slice(script.indexOf('function Invoke-PilotRelease'));
    expect(release.indexOf('Assert-HostedRunner')).toBeGreaterThan(-1);
    expect(release.indexOf('Assert-HostedRunner')).toBeLessThan(
      release.indexOf('Initialize-SigningCertificate'),
    );
  });

  it('requires a Basic Constraints extension on the leaf', () => {
    expect(script).toMatch(/has no Basic Constraints extension/);
  });

  it('removes the signing secrets and the publish tokens from the environment, list by list', () => {
    // Only the names in a `foreach` list that feeds `Remove-Item "Env:$name"` count: a name that stays
    // elsewhere in the script cannot make this pass.
    const lists = [
      ...script.matchAll(/foreach \(\$name in ([^)]+)\) \{\s*Remove-Item "Env:\$name"/g),
    ].map((match) => (match[1] ?? '').split(',').map((name) => name.trim().replaceAll("'", '')));
    expect(lists).toContainEqual(['POS_PILOT_SIGN_PFX_BASE64', 'POS_PILOT_SIGN_PFX_PASSWORD']);
    const stray = lists.find((names) => names.includes('CSC_LINK'));
    expect(stray).toEqual(
      expect.arrayContaining([
        'CSC_KEY_PASSWORD',
        'WIN_CSC_LINK',
        'WIN_CSC_KEY_PASSWORD',
        'GH_TOKEN',
        'GITHUB_TOKEN',
        'BT_TOKEN',
      ]),
    );
  });
});

describe('RT-1347 the pilot lane stamp: exactly one, and nothing else (RT-1345 D1, D5)', () => {
  const workflow = read('../../.github/workflows/release-pos-pilot.yml');
  const buildJob = /^ {2}build:\n([\s\S]*?)(?=^ {2}[a-z][a-z0-9_-]*:\n)/m.exec(workflow)?.[1] ?? '';
  const verify = read('scripts/pilot/verify-pilot-lane-config.ts');
  const code = (text: string): string =>
    text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n');

  it('the stamp lives in the build job of the release workflow and nowhere else', () => {
    expect(buildJob).not.toBe('');
    expect(buildJob).toContain('POS_LANE_CONFIG_LANE: pilot');
    expect(workflow.match(/POS_LANE_CONFIG_/g)).toHaveLength(
      buildJob.match(/POS_LANE_CONFIG_/g)?.length ?? -1,
    );
  });

  it('takes the two public values from repository variables: no secret, no environment on the build job', () => {
    expect(buildJob).toContain('vars.POS_PILOT_LANE_API_BASE_URL');
    expect(buildJob).toContain('vars.POS_PILOT_LANE_DESCOPE_PROJECT_ID');
    expect(buildJob).not.toMatch(/secrets\./);
    expect(code(buildJob)).not.toMatch(/^ {4}environment:/m);
  });

  it('leaves the update origin and channel empty for the pilot lane, and bakes no update feed', () => {
    expect(buildJob).toMatch(/POS_LANE_CONFIG_UPDATE_ORIGIN: ""/);
    expect(buildJob).toMatch(/POS_LANE_CONFIG_UPDATE_CHANNEL: ""/);
    expect(code(workflow)).not.toMatch(
      /ELECTRON_UPDATE_FEED_URL|POS_PULSE_UPDATE_CHANNEL|bake-app-update|app-update\.yml/,
    );
  });

  it('the signing path and the pilot builder config carry no lane configuration of their own', () => {
    const script = read('scripts/pilot/ci/release-pilot-installer.ps1');
    expect(script).not.toMatch(/POS_LANE_CONFIG|lane-config/);
    expect(read('electron-builder.pilot.yml')).not.toMatch(/POS_LANE_CONFIG|lane-config/);
    expect(read('electron-builder.yml')).not.toMatch(/lane-config|extraResources/);
  });

  it('the packaged-file check refuses an update origin and channel and reads no secret', () => {
    expect(verify).toMatch(/updateOrigin must be absent/);
    expect(verify).toMatch(/updateChannel must be absent/);
    expect(verify).toMatch(/config\.lane !== 'pilot'/);
    // The only environment value it reads is the GitHub step-output file.
    const reads = [...verify.matchAll(/env\[(?:'|")(\w+)(?:'|")\]/g)].map((m) => m[1]);
    expect(reads).toEqual(['GITHUB_OUTPUT']);
    expect(verify).not.toMatch(/\b(?:fetch|https?\.request|spawn|exec)\w*\(/);
  });
});

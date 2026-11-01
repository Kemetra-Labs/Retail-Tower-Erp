/**
 * RT-842 (RT-532 S4) — the two SSM Command documents the live lab deploy runs:
 * RT-BackendLabBackup on lab-02 and RT-BackendLabDeploy on lab-01, run by the
 * root .github/workflows/deploy-lab.yml (restored in RT-908). The
 * owner creates them in AWS from these files, and the SSM agent runs them as
 * root, so the files are the security boundary. The checks are static (no AWS,
 * no host): strict parameters that never reach shell text, the RT-532 gate
 * order, no secrets or raw output on stdout, and valid bash. RT-908 Phase B: the
 * target is a backend-core/vX.Y.Z monorepo release; the current one may still be
 * a legacy backend-core-<sha12>.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as yaml from "js-yaml";

const repoRoot = resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string): string => readFileSync(resolve(repoRoot, rel), "utf8").replace(/\r\n/g, "\n");

type Param = { type: string; allowedPattern?: string; allowedValues?: string[]; interpolationType?: string };
type Doc = {
  schemaVersion: string;
  parameters: Record<string, Param>;
  mainSteps: { action: string; name: string; precondition?: unknown; inputs: { timeoutSeconds: string; runCommand: string[] } }[];
};

const load = (file: string): { text: string; doc: Doc; command: string; body: string } => {
  const text = read(`deploy/lab/ssm/${file}`);
  const doc = yaml.load(text) as Doc;
  const command = doc.mainSteps.map((s) => s.inputs.runCommand.join("\n")).join("\n");
  // The bash body the wrapper writes to a root-only file and runs.
  const body = /<<'RT_\w+_SCRIPT'\n([\s\S]*?)\nRT_\w+_SCRIPT\n/.exec(command)?.[1] ?? "";
  return { text, doc, command, body };
};
const backup = load("RT-BackendLabBackup.yaml");
const deploy = load("RT-BackendLabDeploy.yaml");
// RT-1007 (RT-717 C7): the Admin Console swap on lab-01, run by the root deploy-console-lab.yml.
const consoleDeploy = load("RT-ConsoleLabDeploy.yaml");

function bashWorks(): boolean {
  const probe = spawnSync("bash", ["-c", "printf ok"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout === "ok";
}
const haveBash = bashWorks();
if (!haveBash && process.env["CI"]) throw new Error("bash is required in CI for the SSM document syntax checks");
const itBash = haveBash ? it : it.skip;

/** Index of each needle in the deploy body; every one must exist and appear in order. */
function expectInOrder(body: string, needles: string[]): void {
  const at = needles.map((needle) => ({ needle, i: body.indexOf(needle) }));
  for (const { needle, i } of at) expect({ needle, found: i > -1 }).toEqual({ needle, found: true });
  const indices = at.map((a) => a.i);
  expect(indices).toEqual([...indices].sort((a, b) => a - b));
}

describe.each([
  ["RT-BackendLabBackup", backup, ["ReleaseTag", "CurrentRelease", "JiraKey"]],
  ["RT-BackendLabDeploy", deploy, ["ReleaseTag", "ReleaseSha", "ApiDigest", "WorkerDigest", "MigrateDigest", "CurrentRelease", "JiraKey", "BackupName", "BackupSha256", "RollbackAllowed"]],
  ["RT-ConsoleLabDeploy", consoleDeploy, ["ReleaseTag", "ArchiveDigest", "ExpectedSha", "ExpectedPin", "BackendRelease", "JiraKey"]],
])("%s document", (_name, d, params) => {
  it("is a schema 2.2 Command document with one Linux shell step", () => {
    expect(d.doc.schemaVersion).toBe("2.2");
    expect(d.doc.mainSteps).toHaveLength(1);
    expect(d.doc.mainSteps[0]).toMatchObject({ action: "aws:runShellScript", precondition: { StringEquals: ["platformType", "Linux"] } });
    expect(Number(d.doc.mainSteps[0]?.inputs.timeoutSeconds)).toBeGreaterThan(0);
  });

  it("takes exactly its strict String parameters: anchored allowedPattern, no free-form command", () => {
    expect(Object.keys(d.doc.parameters)).toEqual(params);
    for (const [name, p] of Object.entries(d.doc.parameters)) {
      expect({ name, type: p.type }).toEqual({ name, type: "String" });
      expect({ name, pattern: p.allowedPattern }).toEqual({ name, pattern: expect.stringMatching(/^\^.+\$$/) });
      // no wildcard that would admit shell metacharacters or whitespace
      expect({ name, wide: /(^|[^\\])\.[*+]|\\s|\[\^/.test(p.allowedPattern ?? "") }).toEqual({ name, wide: false });
      expect({ name, interpolation: p.interpolationType }).toEqual({ name, interpolation: "ENV_VAR" });
    }
    expect(Object.keys(d.doc.parameters).some((n) => /command|script/i.test(n))).toBe(false);
  });

  it("never pastes a parameter into shell text: no {{ }} placeholder, each value read once from SSM_<name>", () => {
    expect(d.command).not.toContain("{{");
    for (const name of params) {
      expect({ name, uses: [...d.body.matchAll(new RegExp(`\\$\\{?SSM_${name}\\b`, "g"))].length }).toEqual({ name, uses: 1 });
      expect(d.body).toContain(`"\${SSM_${name}:-}"`);
    }
  });

  it("re-validates every parameter in the script before using it", () => {
    for (const name of params) expect(d.body).toMatch(new RegExp(`stop "${name}-missing-or-invalid"`));
  });

  it("prints only fixed RT_* lines: command output goes to a root-only log", () => {
    expect(d.body).toContain('exec 3>&1 >>"$LOG" 2>&1');
    expect(d.body.indexOf('exec 3>&1 >>"$LOG" 2>&1')).toBeLessThan(d.body.indexOf("RELEASE_TAG="));
    expect(d.body).toMatch(/say\(\) \{ printf '%s\\n' "\$\*" >&3; \}/);
    // fd 3 is written only by say()
    expect([...d.body.matchAll(/>&3/g)]).toHaveLength(1);
    for (const line of d.body.split("\n").filter((l) => /\bsay "/.test(l))) expect(line).toMatch(/say "RT_[A-Z]+ /);
    expect(d.body).toContain("umask 077");
  });

  it("holds no secret and dumps no environment, and never pipes a download into a shell", () => {
    expect(d.text).not.toMatch(/set -x|printenv|(^|[|;&]\s*)env\s*($|\|)|declare -p|BASH_XTRACEFD|AKIA[0-9A-Z]{16}|PASSWORD=|SECRET=|TOKEN=/m);
    expect(d.text).not.toMatch(/curl[^\n|]*\|\s*(ba|z)?sh\b|wget[^\n|]*\|\s*(ba|z)?sh\b|(ba)?sh\s+<\(\s*curl/);
    expect(d.text).not.toMatch(/AWS-RunShellScript|StartSession/);
    expect(d.text).not.toMatch(/latest/i);
  });

  it("runs the body with bash -euo pipefail under a lock, never stdin-fed", () => {
    expect(d.body.startsWith("set -euo pipefail\n")).toBe(true);
    expect(d.command).toMatch(/\/bin\/bash "\$RT_SCRIPT" \|\| RC=\$\?/);
    expect(d.body).toMatch(/flock -n 9 \|\| stop/);
  });

  itBash("is valid bash", () => {
    const r = spawnSync("bash", ["-n"], { input: d.body, encoding: "utf8" });
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: "" });
    const wrapper = spawnSync("bash", ["-n"], { input: d.command, encoding: "utf8" });
    expect(wrapper.status).toBe(0);
  });
});

describe("RT-BackendLabBackup (lab-02, D-1a)", () => {
  const b = backup.body;

  it("dumps with pg_dump -Fc as the postgres user, checksums it, and verifies the checksum", () => {
    expectInOrder(b, ["sudo -u postgres pg_dump -Fc", 'sha256sum "$DUMP"', "sha256sum --check --strict --quiet"]);
    // FORCE RLS tables cannot be dumped by the owner role
    expect(b).not.toMatch(/pg_dump[^\n]*-U\s/);
  });

  it("rehearses the restore into a scratch database with table-count parity, then drops it", () => {
    expectInOrder(b, ['createdb "$SCRATCH"', "pg_restore --exit-on-error", 'SRC_TABLES="$(', 'RST_TABLES="$(', '[ "$SRC_TABLES" = "$RST_TABLES" ] || stop "table-count-mismatch"', "drop_scratch\n"]);
    expect(b).toContain("trap drop_scratch EXIT");
  });

  it("prints only the backup name and checksum as its result", () => {
    expect(b).toContain('say "RT_BACKUP name=$NAME sha256=$SUM"');
    expect(b.indexOf('say "RT_BACKUP')).toBeGreaterThan(b.indexOf('say "RT_GATE backup-restore-rehearsal pass'));
    // ids, never the raw tag: no `/` reaches the file name
    expect(b).toContain('NAME="rtlab-${CURRENT_RELEASE#backend-core[-/]}-to-${RELEASE_TAG#backend-core/}-$STAMP.dump"');
  });

  it("names backups in the form the deploy document's BackupName parameter accepts", () => {
    const pattern = new RegExp(deploy.doc.parameters.BackupName?.allowedPattern ?? "^$");
    expect(pattern.test("rtlab-046b7f7cff53-to-v0.1.0-20261023T120000Z.dump")).toBe(true);
    expect(pattern.test("rtlab-v0.1.0-to-v0.2.0-20261023T120000Z.dump")).toBe(true);
    expect(pattern.test("rtlab-046b7f7cff53-to-v0.1.0-20261023T120000Z.dump; id")).toBe(false);
    // a legacy release is never a target
    expect(pattern.test("rtlab-046b7f7cff53-to-1711813df1f3-20261023T120000Z.dump")).toBe(false);
    expect(pattern.test("rtlab-backend-core/v0.1.0-to-v0.2.0-20261023T120000Z.dump")).toBe(false);
  });

  itBash("derives exactly those names from both tag forms", () => {
    const name = /\n(NAME="rtlab-[^\n]+)\n/.exec(b)?.[1] ?? "";
    const run = (current: string, target: string): string =>
      spawnSync("bash", ["-c", `CURRENT_RELEASE='${current}' RELEASE_TAG='${target}' STAMP=20261023T120000Z; ${name}; printf %s "$NAME"`], { encoding: "utf8" }).stdout;
    expect(run("backend-core-046b7f7cff53", "backend-core/v0.1.0")).toBe("rtlab-046b7f7cff53-to-v0.1.0-20261023T120000Z.dump");
    expect(run("backend-core/v0.1.0", "backend-core/v0.1.10")).toBe("rtlab-v0.1.0-to-v0.1.10-20261023T120000Z.dump");
  });
});

describe("RT-BackendLabDeploy (lab-01)", () => {
  const b = deploy.body;

  it("reads and rewrites the env file the lab-01 dc wrapper passes as --env-file", () => {
    expect(b).toContain("BACKEND_ENV=/root/rt-lab-secrets/backend.env");
    expect(b).not.toContain('BACKEND_ENV="$BACKEND_DIR/backend.env"');
    expectInOrder(b, [
      "GATE=G-Host",
      `DC_ACTIVE="$(grep -vE '^[[:space:]]*#' "$DC" || true)"`,
      '[ "$ENV_FILES_OK" -ge 1 ] && [ "$ENV_FILES_OK" = "$ENV_FILES" ] || stop "wrapper-does-not-use-BACKEND_ENV"',
      "pass G-Host",
    ]);
    expect(b).not.toContain('grep -qF -- "$BACKEND_ENV" "$DC"');
  });

  it("follows the RT-532 order: host, backup, fetch, config backup, auto-revert, migrate, grants, catch-up, start, ready, cancel", () => {
    expectInOrder(b, [
      "GATE=G-Host",
      "pass G-Host",
      "GATE=G-Backup",
      "pass G-Backup",
      "GATE=fetch",
      "GATE=backup-config",
      "GATE=arm-revert",
      'systemd-run --unit="$UNIT" --on-active="$REVERT_AFTER"',
      'mv "$DC.next" "$DC"',
      '"$DC" run --rm migrate </dev/null || stop "migrate-failed"',
      "psql_client bash deploy/apply-domain-grants.sh",
      "erpnext-posting-resolution-catchup.sql",
      "inventory-effect-integration-catchup.sql",
      '"$DC" up -d </dev/null || stop "compose-up-failed"',
      'running_matches api "$API_REF"',
      "GATE=G-Ready",
      'deploy/console-smoke.sh" "http://$ORIGIN_HOST"',
      'systemctl stop "$UNIT.timer"',
      'say "RT_DONE release=$RELEASE_TAG"',
    ]);
  });

  it("G-Host: changes nothing unless the running images and SENTRY_RELEASE are the CurrentRelease's", () => {
    const host = b.slice(b.indexOf("GATE=G-Host"), b.indexOf("pass G-Host"));
    expect(host).toContain('[ "$SENTRY" = "$CUR_ID" ] || stop');
    expect(host).toContain('running_matches api "$PRIOR_API" || stop');
    expect(host).toContain('running_matches worker "$PRIOR_WORKER" || stop');
    expect(host).not.toMatch(/\bcp\b|\bmv\b|sed -i|docker (run|pull)|"\$DC" (run|up)/);
    // an earlier run's revert unit (armed or elapsed) would undo this run
    expect(host).toContain("--state=active,activating,reloading \\\n");
    expect(host).toContain("'rt-deploy-revert-*' </dev/null)\" || stop \"revert-unit-query-failed\"");
    expect(host).toContain('[ -z "$ARMED" ] || stop "an-earlier-auto-revert-is-armed-or-elapsed"');
    expect(host.indexOf("an-earlier-auto-revert-is-armed-or-elapsed")).toBeLessThan(host.indexOf("running_matches api"));
  });

  it("refuses an empty or malformed backup reference (narrow anchored name, 64-hex checksum)", () => {
    expect(deploy.doc.parameters.BackupSha256?.allowedPattern).toBe("^[0-9a-f]{64}$");
    expect(deploy.doc.parameters.BackupName?.allowedPattern).toBe(
      "^rtlab-([0-9a-f]{12}|v[0-9]+\\.[0-9]+\\.[0-9]+)-to-v[0-9]+\\.[0-9]+\\.[0-9]+-[0-9]{8}T[0-9]{6}Z\\.dump$",
    );
    expect(deploy.doc.parameters.RollbackAllowed?.allowedValues).toEqual(["true", "false"]);
    // re-checked in bash: an empty value fails the same anchored match
    expect(b).toContain('BACKUP_NAME="${SSM_BackupName:-}"');
    expect(b).toContain('[[ "$BACKUP_SHA256" =~ ^[0-9a-f]{64}$ ]] || stop "BackupSha256-missing-or-invalid"');
    expect(b).toContain('[[ "$BACKUP_NAME" =~ ^rtlab-([0-9a-f]{12}|v[0-9]+\\.[0-9]+\\.[0-9]+)-to-(v[0-9]+\\.[0-9]+\\.[0-9]+)-([0-9]{8})T([0-9]{6})Z\\.dump$ ]]');
  });

  it("G-Host: the readiness probe must already pass on the current release, and a redirect names the contract", () => {
    const host = b.slice(b.indexOf("GATE=G-Host"), b.indexOf("pass G-Host"));
    expect(host).toContain('CODE="$(origin_ready_code)"');
    expect(host).toContain('3??) stop "origin-port-80-redirects-CADDY_SITE_ADDRESS-must-be-http-scheme"');
    expect(host).toContain('*) stop "origin-health-ready-not-200-on-the-current-release"');
    // G-Ready uses the same probe
    expect(b.slice(b.indexOf("GATE=G-Ready"))).toContain('CODE="$(origin_ready_code)"');
  });

  it("pulls every image before the revert is armed, so the start spends no revert time downloading", () => {
    const pull = b.indexOf('docker pull --quiet "$REF" </dev/null || stop "image-pull-failed"');
    expect(pull).toBeGreaterThan(b.indexOf("GATE=fetch"));
    expect(pull).toBeLessThan(b.indexOf("systemd-run --unit"));
    expect(b).toContain('for REF in "$MIGRATE_REF" "$API_REF" "$WORKER_REF" "$PSQL_IMAGE"; do');
  });

  it("G-Backup: accepts only a fresh backup of this release pair", () => {
    const gate = b.slice(b.indexOf("GATE=G-Backup"), b.indexOf("pass G-Backup"));
    expect(gate).toContain('[ "$BK_CUR" = "$CUR_ID" ] && [ "$BK_TGT" = "$TGT_ID" ] || stop');
    expect(gate).toContain('[ "$AGE" -le "$BACKUP_MAX_AGE_SECONDS" ] || stop');
  });

  // RT-908 Phase B: monorepo releases, a legacy current release, and no raw `/` tag in a path or pattern.
  it("targets only a monorepo release; the current release may still be a legacy one", () => {
    const tag = new RegExp(deploy.doc.parameters.ReleaseTag?.allowedPattern ?? "^$");
    const current = new RegExp(deploy.doc.parameters.CurrentRelease?.allowedPattern ?? "^$");
    expect(tag.test("backend-core/v0.1.0")).toBe(true);
    expect(tag.test("backend-core-046b7f7cff53")).toBe(false);
    expect(tag.test("backend-core/v0.1.0/../x")).toBe(false);
    expect(current.test("backend-core-046b7f7cff53")).toBe(true);
    expect(current.test("backend-core/v0.1.0")).toBe(true);
    expect(current.test("backend-core/v0.1")).toBe(false);
    expect(deploy.doc.parameters.ReleaseSha?.allowedPattern).toBe("^[0-9a-f]{40}$");
    for (const d of [backup, deploy]) {
      expect(d.doc.parameters.ReleaseTag?.allowedPattern).toBe(deploy.doc.parameters.ReleaseTag?.allowedPattern);
      expect(d.doc.parameters.CurrentRelease?.allowedPattern).toBe(deploy.doc.parameters.CurrentRelease?.allowedPattern);
    }
    expect(b).toContain("REPO=Kemetra-Labs/Retail-Tower-Erp\n");
    expect(b).toContain("IMAGE_PREFIX=ghcr.io/kemetra-labs/backend-core-\n");
    expect(deploy.text).not.toMatch(/ghcr\.io\/kemetra\/|Kemetra\/Backend-Core/);
  });

  it("never uses a raw release tag as a file name or in a pattern: slugs, ids and an anchored directory matcher", () => {
    // the raw tags appear only where they are validated, logged, put in the download URL, or reported
    const raw = b.split("\n").filter((l) => /\$\{?(RELEASE_TAG|CURRENT_RELEASE)\b/.test(l) && !/^\s*#/.test(l));
    for (const line of raw) {
      expect({ line, ok: /=~|^\s*(TGT|CUR)_SLUG=|^\s*(RELEASE_TAG|CURRENT_RELEASE)="\$\{SSM_|^\s*echo "deploy for|BASE="https:\/\/github\.com\/\$REPO\/releases\/download\/\$RELEASE_TAG"|say "RT_DONE release=\$RELEASE_TAG"|^\s*"\$TGT_DIR\/release-manifest\.json" "\$RELEASE_SHA" "\$RELEASE_TAG" <\/dev\/null \|\| stop "manifest-is-not-ReleaseSha-ReleaseTag"$/.test(line) }).toEqual({ line, ok: true });
    }
    expect(b).toContain('CUR_DIR="$BACKEND_DIR/release-$CUR_SLUG"');
    expect(b).toContain('TGT_DIR="$BACKEND_DIR/release-$TGT_SLUG"');
    expect(b).toContain('BUNDLE="backend-core-release-${RELEASE_SHA:0:12}"');
    // the fetched bundle must be the one the workflow verified, whether downloaded now or already present
    const sums = b.indexOf('sha256sum --check --strict --quiet SHA256SUMS) || stop "bundle-files-do-not-match-their-SHA256SUMS"');
    const named = b.indexOf('stop "manifest-is-not-ReleaseSha-ReleaseTag"');
    expect(sums).toBeGreaterThan(b.indexOf("fi", b.indexOf('mv "$WORK/extract" "$TGT_DIR"')));
    expect(named).toBeGreaterThan(sums);
    expect(named).toBeLessThan(b.indexOf("release-env-api-is-not-ApiDigest"));
    expect(b).toMatch(/m\.get\("sha"\) == sys\.argv\[2\] and m\.get\("releaseTag"\) == sys\.argv\[3\]/);
    expect(b).toContain('grep -qE "$CUR_DIR_RE" "$DC" || stop "wrapper-does-not-use-the-current-release"');
    expect(b).toContain('sed -E "s#$CUR_DIR_RE#release-$TGT_SLUG\\1#g" "$DC" > "$RUN_DIR/dc.next"');
    expect(b).toContain('! grep -qE "$CUR_DIR_RE" "$RUN_DIR/dc.next" || stop "next-wrapper-still-uses-the-current-release"');
    expect(b).toContain('cmp -s "$DC" "$RUN_DIR/dc.next" || stop "same-release-wrapper-changed"');
    expect(b).toContain('sed -i "s|^SENTRY_RELEASE=.*|SENTRY_RELEASE=$TGT_ID|" "$RUN_DIR/backend.env.next"');
  });

  itBash("rewrites only the current release directory in the wrapper, for both tag forms", () => {
    const start = b.indexOf('TGT_SLUG="');
    const defs = b.slice(start, b.indexOf("API_REF=", start));
    const script = (current: string, target: string, wrapper: string): string =>
      `CURRENT_RELEASE='${current}' RELEASE_TAG='${target}'\n${defs}\nprintf '%s' '${wrapper}' | sed -E "s#$CUR_DIR_RE#release-$TGT_SLUG\\1#g"; printf '|%s|%s' "$TGT_ID" "$CUR_ID"`;
    const run = (current: string, target: string, wrapper: string): string => spawnSync("bash", ["-c", script(current, target, wrapper)], { encoding: "utf8" }).stdout;
    expect(run("backend-core-046b7f7cff53", "backend-core/v0.1.0", "--env-file /opt/rt-lab/backend/release-backend-core-046b7f7cff53/release.env")).toBe(
      "--env-file /opt/rt-lab/backend/release-backend-core-v0.1.0/release.env|v0.1.0|046b7f7cff53",
    );
    // v0.1.1 is a prefix of v0.1.10, and `.` is not a wildcard
    expect(run("backend-core/v0.1.1", "backend-core/v0.2.0", "a release-backend-core-v0.1.10/x b release-backend-core-v0x1x1/y c release-backend-core-v0.1.1")).toBe(
      "a release-backend-core-v0.1.10/x b release-backend-core-v0x1x1/y c release-backend-core-v0.2.0|v0.2.0|v0.1.1",
    );
  });

  // RT-1032: a same-release redeploy (CurrentRelease == ReleaseTag) must pass the next-wrapper
  // guard with an unchanged wrapper; another release must leave no trace of the current one.
  itBash("builds the next wrapper for another release and keeps it unchanged for the same release", () => {
    const start = b.indexOf('TGT_SLUG="');
    const defs = b.slice(start, b.indexOf("API_REF=", start));
    const guard = b.slice(b.indexOf('sed -E "s#$CUR_DIR_RE#'), b.indexOf('cp -p "$BACKEND_ENV" "$RUN_DIR/backend.env.next"'));
    expectInOrder(b, ['TGT_SLUG="', "API_REF=", 'sed -E "s#$CUR_DIR_RE#', 'cp -p "$BACKEND_ENV" "$RUN_DIR/backend.env.next"']);
    const run = (current: string, target: string, guardBlock = guard): { status: number | null; out: string } => {
      const script = [
        "set -euo pipefail",
        'stop() { echo "STOP:$1"; exit 3; }',
        'RUN_DIR="$(mktemp -d)"; DC="$RUN_DIR/dc.wrapper"',
        `printf '%s\\n' 'exec docker compose --env-file /opt/rt-lab/backend/release-${current.replace("/", "-")}/release.env "$@"' > "$DC"`,
        `CURRENT_RELEASE='${current}' RELEASE_TAG='${target}'`,
        defs,
        guardBlock,
        'cat "$RUN_DIR/dc.next"',
      ].join("\n");
      const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
      return { status: r.status, out: r.stdout };
    };
    const other = run("backend-core/v0.3.2", "backend-core/v0.3.3");
    expect(other.status).toBe(0);
    expect(other.out).toContain("release-backend-core-v0.3.3/release.env");
    expect(other.out).not.toContain("release-backend-core-v0.3.2");
    const same = run("backend-core/v0.3.3", "backend-core/v0.3.3");
    expect(same.out).not.toContain("STOP:");
    expect(same.status).toBe(0);
    expect(same.out).toContain("release-backend-core-v0.3.3/release.env");
    // the equality check must refuse a same-release wrapper that changed anyway
    const branch = 'if [ "$CUR_SLUG" = "$TGT_SLUG" ]; then';
    expect(guard).toContain(branch);
    const tampered = run("backend-core/v0.3.3", "backend-core/v0.3.3", guard.replace(branch, `printf '%s\\n' tampered >> "$RUN_DIR/dc.next"\n${branch}`));
    expect(tampered.status).toBe(3);
    expect(tampered.out).toContain("STOP:same-release-wrapper-changed");
  });

  it("fetches the bundle over https only, checks SHA256SUMS before unpacking, and binds release.env to the digests", () => {
    const fetch = b.slice(b.indexOf("GATE=fetch"), b.indexOf("pass fetch"));
    expect(fetch).toContain("curl -fsSL --proto '=https'");
    expect(fetch).toContain('--max-filesize "$MAX_ASSET_BYTES"');
    expectInOrder(fetch, ["sha256sum --check --strict SHA256SUMS", "bundle-holds-a-non-regular-entry", "unsafe-bundle-entry-path", "tar -xzf", "--strip-components=1"]);
    for (const [key, ref] of [["DP2_API_IMAGE", "API_REF"], ["DP2_WORKER_IMAGE", "WORKER_REF"], ["DP2_MIGRATE_IMAGE", "MIGRATE_REF"]]) {
      expect(fetch).toContain(`[ "$(env_value "$TGT_DIR/release.env" ${key})" = "$${ref}" ] || stop`);
    }
  });

  it("arms a 15-minute auto-revert before anything changes, app-only only when RollbackAllowed=true", () => {
    expect(b).toContain("REVERT_AFTER=15min");
    expect(b.indexOf("systemd-run")).toBeLessThan(b.indexOf('mv "$DC.next" "$DC"'));
    const arm = b.slice(b.indexOf("GATE=arm-revert"), b.indexOf("pass arm-revert"));
    const [allowed, blocked] = arm.split("\nelse\n");
    expect(arm).toContain('if [ "$ROLLBACK_ALLOWED" = true ]; then');
    expect(allowed).toContain('cp -p "$RUN_DIR/dc" "$DC"');
    expect(allowed).toContain('cp -p "$RUN_DIR/backend.env" "$BACKEND_ENV"');
    // both revert variants claim the shared outcome before doing anything, and give up if it is taken
    for (const variant of [allowed, blocked]) {
      expect(variant).toContain('mkdir "$RUN_DIR/outcome" 2>/dev/null || exit 0');
      expect(variant?.indexOf('mkdir "$RUN_DIR/outcome"')).toBeLessThan(variant?.indexOf("REVERT-STARTED") ?? -1);
    }
    expect((allowed ?? "").indexOf('mkdir "$RUN_DIR/outcome"')).toBeLessThan((allowed ?? "").indexOf('cp -p "$RUN_DIR/dc" "$DC"'));
    // after a schema change, the revert only records that an owner decision is needed
    expect(blocked).toContain("REVERT-BLOCKED");
    expect(blocked).not.toMatch(/"\$DC"|cp -p|docker/);
  });

  it("cancels the auto-revert only after readiness and the console smoke pass", () => {
    expect(b.indexOf('systemctl stop "$UNIT.timer"')).toBeGreaterThan(b.indexOf("pass console-smoke"));
    expect([...b.matchAll(/systemctl stop/g)]).toHaveLength(1);
  });

  it("never reports success over a revert that fired: window check before start, fired/ran checks at cancel", () => {
    // the start cutoff leaves room for everything after it: up + catch-up, readiness, smoke, margin
    expect(b).toContain(
      "MAX_SECONDS_BEFORE_START=$(( REVERT_SECONDS - POST_START_SECONDS - READY_TIMEOUT_SECONDS - SMOKE_SECONDS - CANCEL_MARGIN_SECONDS ))",
    );
    const num = (name: string): number => Number(new RegExp(String.raw`\n${name}=(\d+)\n`).exec(b)?.[1]);
    expect(num("REVERT_SECONDS")).toBe(15 * 60);
    expect(b).toContain("REVERT_AFTER=15min");
    // console-smoke: 8 requests of at most SMOKE_MAX_TIME (10 s) each
    const smokeRequests = [...read("deploy/console-smoke.sh").matchAll(/\$\(get /g)].length;
    expect(num("SMOKE_SECONDS")).toBeGreaterThanOrEqual(smokeRequests * 10);
    const cutoff = num("REVERT_SECONDS") - num("POST_START_SECONDS") - num("READY_TIMEOUT_SECONDS") - num("SMOKE_SECONDS") - num("CANCEL_MARGIN_SECONDS");
    expect(cutoff).toBeGreaterThan(0);
    expect(num("CANCEL_MARGIN_SECONDS")).toBeGreaterThanOrEqual(60);
    expect(b.indexOf('ARMED_AT="$(date +%s)"')).toBeLessThan(b.indexOf("too-little-revert-window-left-to-start"));
    expect(b.indexOf("too-little-revert-window-left-to-start")).toBeLessThan(b.indexOf('"$DC" up -d </dev/null ||'));
    const cancel = b.slice(b.indexOf("GATE=cancel-revert"), b.indexOf("RT_DONE"));
    expectInOrder(cancel, [
      // a fired one-shot timer stays active (sub-state elapsed): judge by sub-state and trigger time
      '[ "$(systemctl show -p SubState --value "$UNIT.timer")" = waiting ] || stop "auto-revert-already-fired"',
      '[ "$(systemctl show -p LastTriggerUSecMonotonic --value "$UNIT.timer")" = 0 ] || stop "auto-revert-already-fired"',
      // every check that can fail runs before the claim, while the revert is still armed
      '[ ! -e "$RUN_DIR/REVERT-STARTED" ] && [ ! -e "$RUN_DIR/REVERTED" ] && [ ! -e "$RUN_DIR/REVERT-BLOCKED" ] || stop "auto-revert-ran"',
      'running_matches api "$API_REF" || stop "running-api-changed-after-readiness"',
      'running_matches worker "$WORKER_REF" || stop "running-worker-changed-after-readiness"',
      // the decision is an atomic claim the revert script also makes first, so a revert queued
      // just before the stop can never also run after this run reports success
      'mkdir "$RUN_DIR/outcome" 2>/dev/null || stop "auto-revert-ran"',
      'systemctl stop "$UNIT.timer" || { release_claim; stop "auto-revert-not-cancelled"; }',
      '! systemctl is-active --quiet "$UNIT.timer" || { release_claim; stop "auto-revert-still-active"; }',
      'say "RT_REVERT cancelled',
    ]);
  });

  it("after the claim, every failure gives the claim back so the armed revert still runs", () => {
    const cancel = b.slice(b.indexOf("GATE=cancel-revert"), b.indexOf("RT_DONE"));
    const afterClaim = cancel.slice(cancel.indexOf('mkdir "$RUN_DIR/outcome"'));
    expect(cancel).toContain('release_claim() { rm -f "${RUN_DIR:?}/outcome/by"; rmdir "${RUN_DIR:?}/outcome"; }');
    // each stop after the claim is preceded by release_claim (bar the claim's own refusal)
    const stops = afterClaim.split("\n").filter((l) => l.includes("stop \"") && !l.startsWith("mkdir "));
    expect(stops.length).toBeGreaterThan(0);
    for (const line of stops) expect(line).toMatch(/\{ release_claim; stop "[a-z-]+"; \}$/);
    // no running-image check (which could fail) is left after the claim
    expect(afterClaim).not.toContain("running_matches");
  });

  it("orders migrate, grants, catch-up, up, catch-up, readiness, cancel revert", () => {
    const catchups = [...b.matchAll(/psql_client sh -c 'psql -X -v ON_ERROR_STOP=1 -f docs\/operations\/sql\/erpnext-posting-resolution-catchup\.sql/g)].map((m) => m.index ?? -1);
    expect(catchups).toHaveLength(2);
    const steps = [
      b.indexOf('"$DC" run --rm migrate </dev/null'),
      b.indexOf("psql_client bash deploy/apply-domain-grants.sh"),
      catchups[0] ?? -1,
      b.indexOf('"$DC" up -d </dev/null ||'),
      catchups[1] ?? -1,
      b.indexOf("GATE=G-Ready"),
      b.indexOf('systemctl stop "$UNIT.timer"'),
    ];
    expect(steps.every((i) => i > -1)).toBe(true);
    expect(steps).toEqual([...steps].sort((x, y) => x - y));
  });

  it("a failed post-start catch-up stops before readiness, leaving the auto-revert armed", () => {
    const post = b.slice(b.indexOf("pass start"), b.indexOf("GATE=G-Ready"));
    expect(post).toMatch(/\|\| stop "post-start-catch-up-failed"/);
    // stop() exits; the only cancel is after readiness and the smoke
    expect(b).toMatch(/stop\(\) \{ [^}]*exit 1; \}/);
    expect(b.indexOf('systemctl stop "$UNIT.timer"')).toBeGreaterThan(b.indexOf("pass console-smoke"));
    expect(b).not.toMatch(/trap[^\n]*systemctl/);
  });

  it("runs the catch-up scripts before and again after the start, as README Deploy step 4 does", () => {
    const runs = [...b.matchAll(/-f docs\/operations\/sql\/erpnext-posting-resolution-catchup\.sql/g)].map((m) => m.index ?? -1);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toBeLessThan(b.indexOf('"$DC" up -d </dev/null ||'));
    expect(runs[1]).toBeGreaterThan(b.indexOf("pass start"));
    expect(runs[1]).toBeLessThan(b.indexOf("GATE=G-Ready"));
  });

  it("extracts a fetched bundle world-readable (no secrets in it; containers bind-mount its files)", () => {
    expect(b).toMatch(/\(umask 022 && mkdir "\$WORK\/extract" \\\n\s+&& tar -xzf/);
  });

  it("never downgrades the database", () => {
    expect(deploy.text).not.toMatch(/migrate[^\n]*\bdown\b|\.down\.sql|pg_restore|dropdb|DROP (TABLE|SCHEMA|DATABASE)/i);
  });

  it("runs grants and catch-up in a digest-pinned psql client with the root-only migration-owner env file", () => {
    expect(b).toMatch(/PSQL_IMAGE=postgres:16-bookworm@sha256:[0-9a-f]{64}\n/);
    expect(b).toContain('docker run --rm --network host --env-file "$GRANTS_ENV" -v "$TGT_DIR:/release:ro"');
    expect(b).toContain("psql -X -v ON_ERROR_STOP=1 -f docs/operations/sql/erpnext-posting-resolution-catchup.sql");
    expect(b).not.toMatch(/postgres(ql)?:\/\//);
  });

  it("keeps stdin off every docker and compose call, and reads only the image field from docker inspect", () => {
    // continuation lines joined, so a redirect on the last line of a command counts
    const joined = b.replace(/\\\n\s*/g, " ");
    for (const line of joined.split("\n").filter((l) => /(^|\s)(docker (run|inspect|image inspect|ps)|"\$DC" (run|up))\b/.test(l) && !l.trim().startsWith("#"))) {
      expect(line).toMatch(/<\/dev\/null/);
    }
    for (const line of b.split("\n").filter((l) => /docker (image )?inspect/.test(l) && !l.trim().startsWith("#"))) {
      expect(line).toMatch(/\| python3 -c 'import json, sys; print\(json\.load\(sys\.stdin\)\[0\]\["(Image|Id)"\]\)'$/);
    }
  });

  it("stops at the first failure: every gate step ends in stop on failure", () => {
    for (const needle of ['"$DC" run --rm migrate', "psql_client bash deploy/apply-domain-grants.sh", '"$DC" up -d </dev/null ||', "console-smoke.sh"]) {
      const line = b.split("\n").find((l) => l.includes(needle)) ?? "";
      expect({ needle, line }).toEqual({ needle, line: expect.stringMatching(/\|\| stop "[a-z-]+"$/) });
    }
  });
});

describe("RT-ConsoleLabDeploy (lab-01, RT-1007)", () => {
  const b = consoleDeploy.body;
  const params = consoleDeploy.doc.parameters;

  it("follows the order host, fetch, check, swap, smoke", () => {
    expectInOrder(b, [
      "GATE=G-Host",
      "pass G-Host",
      "GATE=fetch",
      "pass fetch",
      "GATE=check",
      'stop "version-json-is-not-ExpectedPin"',
      "pass check",
      "GATE=swap",
      'mv -Tf "$CONSOLE_DIR/current.next" "$CONSOLE_DIR/current" || stop "swap-failed"',
      "pass swap",
      "GATE=G-Smoke",
      'smoke_fail "console-smoke-failed"',
      'say "RT_DONE release=$RELEASE_TAG"',
    ]);
  });

  it("takes the Backend-Core deploy's lock, so the two never run at once on lab-01", () => {
    expect(b).toContain("exec 9>/run/rt-lab-deploy.lock\n");
    expect(deploy.body).toContain("exec 9>/run/rt-lab-deploy.lock\n");
  });

  it("deploys only monorepo releases; the Backend-Core release must be a monorepo release too", () => {
    const tag = new RegExp(params.ReleaseTag?.allowedPattern ?? "^$");
    expect(tag.test("admin-console/v0.1.0")).toBe(true);
    expect(tag.test("admin-console-50d8aa029177")).toBe(false);
    expect(tag.test("admin-console/v0.1.0/../x")).toBe(false);
    expect(params.BackendRelease?.allowedPattern).toBe(deploy.doc.parameters.ReleaseTag?.allowedPattern);
    expect(params.ArchiveDigest?.allowedPattern).toBe("^sha256:[0-9a-f]{64}$");
    expect(params.ExpectedSha?.allowedPattern).toBe("^[0-9a-f]{40}$");
    expect(params.ExpectedPin?.allowedPattern).toBe("^[0-9a-f]{40}$");
  });

  it("G-Host: changes nothing unless lab-01 runs BackendRelease and the Console layout is the recorded one", () => {
    const host = b.slice(b.indexOf("GATE=G-Host"), b.indexOf("pass G-Host"));
    expect(host).toContain('grep -qE "$BACKEND_DIR_RE" "$DC" || stop "wrapper-does-not-use-BackendRelease"');
    expect(host).toContain('[ "$SENTRY" = "$BACKEND_ID" ] || stop "SENTRY_RELEASE-is-not-BackendRelease"');
    expect(host).toContain('[ -L "$CONSOLE_DIR/current" ] || stop "console-layout-missing"');
    expect(host).not.toMatch(/\bln\b|\bmv\b|\bcp\b|\brm\b|tar -x/);
    expect(b).toContain("CONSOLE_DIR=/opt/dp2-console\n");
  });

  it("fetches over https only and checks the archive against its .sha256 and the attested digest before unpacking", () => {
    const fetch = b.slice(b.indexOf("GATE=fetch"), b.indexOf("pass fetch"));
    expect(fetch).toContain("curl -fsSL --proto '=https' --tlsv1.2");
    expect(fetch).toContain('--max-filesize "$MAX_ASSET_BYTES"');
    expectInOrder(fetch, [
      'sha256sum --check --strict "$REL.tar.gz.sha256"',
      '= "$ARCHIVE_DIGEST" ] || stop "archive-is-not-ArchiveDigest"',
      'stop "archive-holds-a-non-regular-entry"',
      'stop "unsafe-archive-entry-path"',
      "tar -xzf",
      'mv -T "$STAGE" "$TGT"',
    ]);
    // never unpacks over an existing release directory
    expect(fetch).toContain('if [ ! -d "$TGT" ]; then');
  });

  it("binds a new or reused release directory to ExpectedSha and ExpectedPin before the swap", () => {
    const check = b.slice(b.indexOf("GATE=check"), b.indexOf("pass check"));
    expect(check).toContain('[ "$(version_field "$TGT/version.json" sha)" = "$EXPECTED_SHA" ] || stop');
    expect(check).toContain('[ "$(version_field "$TGT/version.json" backendContractPin)" = "$EXPECTED_PIN" ] || stop');
    expect(b.indexOf("pass check")).toBeLessThan(b.indexOf("GATE=swap"));
  });

  it("swaps atomically, keeps the previous target, and reverts it on any failed smoke", () => {
    const swap = b.slice(b.indexOf("GATE=swap"), b.indexOf("pass swap"));
    expectInOrder(swap, ['ln -sfn "$PREV" "$CONSOLE_DIR/current.bak-pre-$REL-$RUN_ID"', 'ln -sfn "releases/$REL" "$CONSOLE_DIR/current.next"']);
    const smoke = b.slice(b.indexOf("GATE=G-Smoke"), b.indexOf("pass console-smoke"));
    expect(b).toContain('[ "$SWAPPED" = yes ] || return 0');
    expect(b).toContain('ln -sfn "$PREV" "$CONSOLE_DIR/current.next" && mv -Tf "$CONSOLE_DIR/current.next" "$CONSOLE_DIR/current"');
    expect(smoke).toContain("smoke_fail() { revert; stop \"$1\"; }");
    // every check after the swap reverts on failure; none stops without it
    for (const line of smoke.split("\n").filter((l) => /\|\| (stop|smoke_fail) /.test(l))) expect(line).toMatch(/\|\| smoke_fail "[A-Za-z0-9-]+"$/);
  });

  it("reverts on ANY exit after the swap until the smoke passed, not only a failed check (an abort under set -e too)", () => {
    // the revert runs at most once, and the EXIT trap and signals all go through it
    expect(b).toContain("SWAPPED=reverted");
    expect(b).toContain('if [ "$SWAPPED" = yes ] && [ "$SMOKE_OK" != yes ]; then revert; fi');
    expect(b).toContain("trap on_exit EXIT\n");
    expect(b).toContain("trap 'exit 1' INT TERM HUP\n");
    // the state the trap reads exists before the trap is set (set -u)
    expectInOrder(b, ['PREV=""', "SWAPPED=no", "SMOKE_OK=no", "trap on_exit EXIT", "GATE=G-Host"]);
    // the swap is marked before the mv, so a signal between them cannot leave the new release live
    expect(b).toContain('ln -sfn "releases/$REL" "$CONSOLE_DIR/current.next" && SWAPPED=yes && mv -Tf');
    expect([...b.matchAll(/SWAPPED=yes/g)]).toHaveLength(1);
    // SMOKE_OK is set only after the last smoke check, immediately before the pass
    expect(b).toContain('|| smoke_fail "console-smoke-failed"\nSMOKE_OK=yes\npass console-smoke\n');
    expect([...b.matchAll(/SMOKE_OK=yes/g)]).toHaveLength(1);
  });

  it("smokes the origin on this host, never the public edge (Cloudflare injects a script there, RT-1005 c14785)", () => {
    expect(b).toContain('--resolve "$ORIGIN_HOST:80:127.0.0.1"');
    expect(b).toContain("printf 'resolve = %s:80:127.0.0.1\\n' \"$ORIGIN_HOST\" > \"$WORK/curl/.curlrc\"");
    expect(b).toContain('CURL_HOME="$WORK/curl" bash "$SMOKE" "http://$ORIGIN_HOST"');
    expect(b).not.toContain("https://$ORIGIN_HOST");
  });

  it("never deletes a release: the only removals are its own temporary directories", () => {
    const removals = b.split("\n").filter((l) => /\brm\b/.test(l) && !l.trim().startsWith("#")).map((l) => l.trim());
    expect(removals).toEqual(['rm -rf "$WORK"', 'if [ -n "$STAGE" ]; then rm -rf "$STAGE"; fi']);
    // STAGE is a fresh directory under incoming/, and is cleared once it has been renamed into releases/
    expectInOrder(b, ['STAGE="$CONSOLE_DIR/incoming/.stage-$REL-$RUN_ID"', 'mv -T "$STAGE" "$TGT"', '  STAGE=""\nfi\n']);
    expect(consoleDeploy.command).toContain('rm -f "$RT_SCRIPT"');
  });

  itBash("derives the asset, directory and Backend-Core names from both tags without a raw `/`", () => {
    const start = b.indexOf('REL="');
    const defs = b.slice(start, b.indexOf('echo "console deploy', start));
    const run = (consoleTag: string, backendTag: string, wrapper: string): string =>
      spawnSync("bash", ["-c", `RELEASE_TAG='${consoleTag}' BACKEND_RELEASE='${backendTag}'\n${defs}\nprintf '%s|%s|%s|' "$REL" "$BACKEND_SLUG" "$BACKEND_ID"; grep -qE "$BACKEND_DIR_RE" <<<'${wrapper}' && printf match || printf nomatch`], { encoding: "utf8" }).stdout;
    expect(run("admin-console/v0.1.0", "backend-core/v0.3.2", "--env-file /opt/rt-lab/backend/release-backend-core-v0.3.2/release.env")).toBe(
      "admin-console-v0.1.0|backend-core-v0.3.2|v0.3.2|match",
    );
    // v0.3.2 is a prefix of v0.3.20, and `.` is not a wildcard
    expect(run("admin-console/v0.1.0", "backend-core/v0.3.2", "release-backend-core-v0.3.20/x release-backend-core-v0x3x2/y")).toBe(
      "admin-console-v0.1.0|backend-core-v0.3.2|v0.3.2|nomatch",
    );
  });
});

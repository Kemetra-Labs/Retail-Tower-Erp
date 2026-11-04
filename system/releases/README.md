# System releases

One file per lab system version (RT-1029, RT-1030): the product releases that are deployed together. Each product still releases on its own; a system version only names which releases fit together.

```json
{
  "schema": "retail-tower/system-release@1",
  "system": "lab-YYYY.MM.N",
  "backendCore": {"release": "backend-core/vX.Y.Z"},
  "adminConsole": {"release": "admin-console/vX.Y.Z"},
  "erpnext": {"image": "ghcr.io/kemetra-labs/rt-erpnext@sha256:<64 hex>", "sha": "<40 hex commit on main>"},
  "pos": {"build": "<POS build id from pos-supported.yaml>"}
}
```

The file name is the `system` value plus `.json`. A version that has been deployed live is never edited; a new combination is a new file.

The ERPNext entry is the image digest and the commit it was built from, the inputs of `deploy-erp-lab.yml`, because the Connector has no `vX.Y.Z` releases yet. POS is installed on Windows terminals, not deployed: `pos.build` is the build the terminals run.

## The gate

The `contracts/check` CI job checks every file here:

| Rule | Check | Where |
| --- | --- | --- |
| G1 | exact keys, every value matches its pattern, the file is named after `system` | `.github/release/system_gate.py` |
| G2 | each release tag resolves, and every commit is on `main` | `system_gate.py` |
| G3 | the Admin Console release's `contracts/backend-core/PIN` names the Backend-Core release commit | `system_gate.py` |
| G4 | the Console and Connector PINs at their releases have no breaking change against the Backend-Core contract at its release (`oasdiff breaking`) | `tools/contracts-check --backend-rev --consumer-rev` |
| G5 | the POS build is in `supported:` of `pos-supported.yaml` at the Backend-Core release | `system_gate.py` |

Locally, run `python .github/release/system_gate.py --manifest system/releases/<file>.json`. The checks that need the GitHub API (release immutability, attestations, the compat check run, the ERP image attestation and the `aws-lab` reviewer) run in the deploy workflow's preflight (RT-1031).

## Deploying a system version (runbook)

`.github/workflows/deploy-system-lab.yml` (RT-1031) deploys one system version to the lab. Its inputs:

- `manifest`: the version to deploy.
- `current_manifest`: optional (RT-1084). Empty, it is resolved from the live-state record (step 1a). Given, it must be the file the record names. For a same-version redeploy it is the same file.
- `jira_key`.
- `dry_run`: defaults to `true`.
- `force_all`: defaults to `false`. When `false`, a product that is the same in both files is skipped (RT-1085). `true` runs all four documents, to prove the whole path.

The preflight runs the gate above on both files, plus the online checks of each product and G8 (the live lab check, step 1), and writes a planned system ledger. It changes nothing in AWS: it reads one SSM parameter, the live-state record, with a read-only role (G9, step 1a). A live run needs one `aws-lab` approval, then sends the documents of the step plan in order and stops at the first failure. The ledgers are built by `.github/release/system_ledger.py`. First proven live on 2026-11-01: [run 41306750385](https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/41306750385), RT-1032.

### 1. Find the version live now

`current_manifest` must describe what each host runs. Any per-product deploy moves the lab and makes the current manifest stale: `deploy-lab.yml` (Backend-Core), `deploy-console-lab.yml` (Console) and `deploy-erp-lab.yml` (ERPNext + Connector).

**The preflight checks this for you (G8, `.github/release/live_check.py`).** With the read-only `actions: read` token it reads the live ledgers of those three workflows and of `deploy-system-lab.yml`, takes for each product the newest deploy that finished (a system run counts for the steps it completed), and compares the Backend-Core release, the Console release and the ERP image digest and commit with `current_manifest`. A mismatch refuses the plan as `G8 FAIL: <product>: the live lab runs <x> (<workflow> run <id>), but the current manifest names <y>`, before the live job and before the lab-02 backup. The new `current_manifest` is the file the refusal points to, or a new file by PR (step 3 below).

G8 also looks at runs newer than the last deploy that did not deploy:
- It **refuses** when the run's ledger shows its host may have changed: a Backend-Core run that got past its `backup-config` gate (it arms the auto-revert next) or has a revert, a Console run that swapped or reverted, any ERP run that held, or that failed after its `check` gate, and a run whose live job started but left no ledger. The owner reconciles the host (see the notes under step 2 below), then a successful deploy of that product with its per-product workflow clears the refusal. There is no override input.
- It records a **note** and passes when the ledger shows the run stopped before it reached a host (for example a Backend-Core run refused at `G-Host`, or a live job that never reached SSM).

G8 also fails closed: when a ledger is missing, a run was re-run (its ledger cannot be ordered), a ledger is expired, unreadable or malformed, when a workflow has no deployed ledger in its newest 100 runs, or when the token cannot read the runs. G8 proves what the ledgers say was deployed, not what the hosts run: `RT-BackendLabDeploy` G-Host and `RT-ErpLabDeploy` still check the hosts.

**Known limit of G8 (open, deliberately not changed by RT-1084).** Ledger artifacts are kept 90 days, and G8 fails when a product has no deployed ledger left in them. The live-state record (step 1a) does not remove that dependency, because G8 still reads the ledgers as the second check. Do not run a lab deploy only to refresh a ledger. A separate follow-up decides how G8 should treat a fresh record that agrees with the ledgers that remain.

To do the same by hand, or to find the file after a refusal:

1. Find the latest **live** run of each per-product workflow (dry runs leave no live ledger):

   ```bash
   gh run list --workflow deploy-lab.yml --limit 30
   gh run list --workflow deploy-console-lab.yml --limit 30
   gh run list --workflow deploy-erp-lab.yml --limit 30
   ```

   Raise `--limit` until the list reaches a live run whose ledger `outcome` is `deployed`: dry, failed and held runs can fill the most recent entries.
2. Download its live ledger with `gh run download <run id>`. Use the latest one whose `outcome` is `deployed`: a `failed` run may have reverted, and an ERP `held` run left the target image on lab-03 with the workers down (not a deployed state: resolve it with the owner first). Note what it deployed:
   - `deploy-lab.yml`: `release.tag`.
   - `deploy-console-lab.yml`: `target.release`.
   - `deploy-erp-lab.yml`: `target.digest` and `target.sha`.

   If a `deploy-lab.yml` run newer than that one failed after its `migrate` gate, the database may be ahead of the application. There is no automatic database downgrade, and when `rollbackAllowed` was `false` the auto-revert only records that a decision is needed. Get the owner's confirmation that the application and database are recovered before using the older release as current. G-Host checks the application release, not the database.

   Likewise, if a `deploy-erp-lab.yml` run newer than that one failed after its `swap` gate, lab-03 may run the newer image with the workers down. Get the owner's confirmation that lab-03 was redeployed or restored (`restore.sh`), and from which image, before using the older digest as current. `RT-ErpLabDeploy` checks the declared current images on lab-03 and refuses on a mismatch.
3. If no file here matches all three, add one (the next `lab-YYYY.MM.N`) that describes the live lab, by PR. `contracts/check` runs the gate on it.

Before G8, a stale manifest was refused only on lab-01, before any version changed but after the lab-02 backup had been written, with `RT_FAIL gate=G-Host reason=wrapper-does-not-use-the-current-release`. `lab-2026.11.1` was added for exactly this reason, after RT-473 and RT-807 deployed newer releases. G-Host stays as the check on the host itself.

### 1a. The live-state record (RT-1084, G9)

The durable answer to "what does the lab run now" is one SSM String parameter, `/rt/lab/live-state` (us-east-1), written by `.github/release/live_state.py`. Schema `retail-tower/lab-live-state@1`, at most 4096 bytes, no secrets:

```json
{"schema": "retail-tower/lab-live-state@1", "updatedAt": "<UTC>", "writer": {"workflow": "<one of the four lab deploys>", "runId": 41738798480, "sha": "<40 hex of main>"},
 "system": "lab-YYYY.MM.N or null", "note": "optional text",
 "products": {"backend": {"release": "backend-core/vX.Y.Z", "sha": "<40 hex>", "runId": 41738798480, "at": "<UTC>", "state": "ok"},
              "console": {"release": "admin-console/vX.Y.Z", "sha": "<40 hex>", "runId": 41738798480, "at": "<UTC>", "state": "ok"},
              "erp": {"digest": "sha256:<64 hex>", "sha": "<40 hex>", "runId": 41738798480, "at": "<UTC>", "state": "ok"}},
 "inflight": null}
```

Any other key, a bad pattern, a `dirty` product without a `reason`, or a bigger record is refused.

**Who reads and writes it.** The `deploy-system-lab.yml` preflight reads it with the read-only role `rt-gha-aws-lab-state-read` (repository variable `AWS_STATE_READ_ROLE_ARN`; `ssm:GetParameter` on this parameter only; trust is the `main` branch). It assumes no deploy role. Every live job (`deploy-system-lab.yml`, `deploy-lab.yml`, `deploy-console-lab.yml`, `deploy-erp-lab.yml`) reads and writes it with the deploy role `rt-gha-aws-lab-deploy`, after the `aws-lab` approval. The parameter name is fixed in `live_state.py`: no input or variable changes it.

**G9, in the preflight.**
- Empty `current_manifest`: the one `system/releases/lab-*.json` that names the recorded Backend-Core release, Console release and ERP digest and commit (the file named by the record's `system` breaks a tie; otherwise two matches are refused). Given: it must be that file.
- That one value is used by every later step of both jobs (the gate, G8, the planned ledger, the live job, the final ledger). Both ledgers record `liveState`: the parameter, its version, the sha256 of its value and whether `current_manifest` was `given` or came from the `record`.
- G9 refuses, and writes no output, when the record is missing (`ParameterNotFound`), unreadable (access denied, repeated failures), malformed, of another schema, names no or several manifests, or has a product `dirty` or a run `inflight`. The refusal is a `G9 FAIL: record: <reason>` line in the planned ledger, which has no current manifest and no step plan.
- G8 is unchanged and still runs as the second check.

**The live job.**
1. After approval and before any document it reads the record again. If the version or digest differs from the value read during the preflight, the live job refuses the run (run a new dry run).
2. It marks the run `inflight` (`workflow`, `runId`, `startedAt`, the products the run touches) in one write. If that write fails, no document is sent.
3. The documents run as before.
4. After the ledger is written, `finish` records what the ledger proves, once, only while the record is still the one this run marked:

| Ledger says | Record |
| --- | --- |
| a step finished (`ok`) | that product is `ok`, with the release and commit (or digest and commit) the ledger names |
| a step failed and may have reached its host (the same rule as G8) | that product is `dirty`, with the reason; its old version stays and the target is never recorded |
| a step failed and provably never sent its document, or did not run, or was skipped | that product is exactly as it was |
| the ledger file cannot be read, or is not JSON | `inflight` stays set and no product changes: the next preflight refuses |
| the ledger is JSON but is not a ledger this tool can read | every product the run marked becomes `dirty` |

`inflight` is cleared in the same write. `system` is set only by a system run whose products all match the manifest. Nothing is inferred from a skipped or failed step.

**Failures never produce a false `ok`.** A run that is cancelled, times out or loses its runner before `finish` leaves `inflight` set. A `finish` that fails after it has checked the record is still the one this run marked (the ledger cannot be read, a release commit cannot be found, the write fails) leaves it set too, and says what failed in `state-finish.json` beside the ledger (the artifact), with the record it meant to write when it got that far. The Backend-Core and Console ledgers carry their release commit, so a shallow checkout without tags is enough. In both cases the next preflight refuses with the reason.

**Writes.** SSM has no compare-and-set. The workflows share the `deploy-aws-lab` concurrency group, so lab deploys run one at a time; the record is also re-read before each write and read back after it. A write that errors may still have landed: the record is read back, the intended text means it landed (accepted, never written twice), the unchanged record is tried again (three attempts at most), anything else means another writer changed it and the run stops. A write outside the lock is not prevented, only detected, and only if it lands after this run's read: the owner must not write the record while a lab deploy runs (from its approval to its last step; check that no lab deploy is in progress first). If an owner write lands between a run's read and its write, the version then jumps by two, the run fails loudly, and the value the owner wrote is the previous version in the parameter's history, where the owner can recover it. An owner write between `begin` and `finish` makes `finish` refuse and leave the owner's record as it is.

**Recovery, with no deadlock and no automatic clearing of an uncertain host.** A job never clears `dirty` or `inflight` by itself.
- One product in doubt: run that product's own workflow (`deploy-lab.yml`, `deploy-console-lab.yml` or `deploy-erp-lab.yml`). It may start only when exactly that product is the one in doubt, its own host gates check the host, and only a ledger that proves the deploy makes it `ok`. When it starts, a product left `inflight` by a crashed run is first turned into `dirty` (with the earlier run named), so a recovery run that fails without reaching the host leaves it `dirty`, never `ok`.
- A system run, or a product run while another product is in doubt, is refused. This is deliberate: the owner reads the hosts first.
- More than one product in doubt: the owner reads the hosts (read-only, as for the 2026-11-04 seed: RT-1084 comments 15420 and 15421) and overwrites the record from what the hosts run, with a non-root identity (step 7). No agent or CI job does this.

**No record yet.** The preflight refuses until the owner seeds it once, without overwrite (step 7).

### 2. Choose the target

For an upgrade, draft the new file with `.github/release/draft_manifest.py` (RT-1089), then open a PR with it:

```bash
python .github/release/draft_manifest.py
```

By default it takes:
- the highest published, immutable `backend-core/vX.Y.Z` and `admin-console/vX.Y.Z` releases;
- the ERP image that `build-erp-image.yml` built for the newest commit on `main`, with its commit read from the image's `org.opencontainers.image.revision` label. The image must carry the Connector tree and base labels the deploy preflight requires, and pass `gh attestation verify` against that workflow on `refs/heads/main`;
- the POS build of the newest file here.

The newest image is the one whose commit has every other candidate as an ancestor. It stops instead of falling back to an older image when that image is not attested, when two images share that commit, or when no single commit has all the others as ancestors: choose one with `--erp`. Any failure of `gh`, the registry or `git` stops it too, so `git fetch origin` first.

It names the draft with the next free `lab-YYYY.MM.N` of this month and runs `system_gate.py` on it (G1, G2, G3 and G5; G4 runs in the `contracts/check` CI job of the PR that adds the file), then writes it only when the gate passes. Exit codes: 0 means written (with `--print`, printed, without running the gate or writing); 1 means the gate refused the draft; 2 means no draft could be made (bad input, or a failure of `gh`, the registry or `git`). Nothing is written unless it exits 0 without `--print`. Override any part with `--backend <tag>`, `--console <tag>`, `--erp sha256:<digest>`, `--pos <build>`, `--current <file>` or `--system <name>`; `--print` shows the draft without writing it. It never overwrites an existing file. It needs `gh` signed in (releases, attestations); the image registry is public and read anonymously. The deploy preflight still checks every product online.

| Goal | `manifest` | `current_manifest` | `force_all` |
| --- | --- | --- | --- |
| Prove the path, change no version | the live file | the same file | `true` |
| Upgrade | a new file | the live file | `false` |

**The step plan (RT-1085).** The preflight compares the two files and decides, for each document, whether it runs:

| Step | Skipped when |
| --- | --- |
| `backup` | the Backend-Core step is skipped (the deploy reads the backup the backup step reports) |
| `backend` | `backendCore.release` is the same tag in both files, and the tag resolves to a commit |
| `console` | `adminConsole.release` is the same tag in both files, and the tag resolves to a commit |
| `erp` | `erpnext.image` (digest) and `erpnext.sha` are the same in both files |

A tag that cannot be resolved counts as changed, so its step runs. Releases are immutable (G2), so one tag always names one commit. The planned ledger lists the plan under `stepPlan`, with a reason for each step, and `summary.md` shows it under "Steps", so the approver sees it before approving. A live run where every step would be skipped is refused in the preflight (`nothing to deploy`); set `force_all=true` to prove the path. G3 ties the Console to the Backend-Core release commit, so a Backend-Core upgrade always comes with a Console upgrade.

The planned ledger reports two rollback rules:
- `backend.rollbackAllowed` (`rollbackAllowed` in the live ledger): `false` when the Backend-Core releases differ in migrations, or when the verifier could not compare them. The auto-revert then only records that an owner restore or forward fix is needed.
- `erp.rollbackClass` (`erpRollbackClass` in the live ledger): `image-only` or `restore`.

### 3. Dry run

```bash
gh workflow run deploy-system-lab.yml --ref main -f manifest=system/releases/<target>.json -f current_manifest=system/releases/<live>.json -f jira_key=RT-<n> -f dry_run=true
```

`<target>` and `<live>` are the files from step 2; for a same-version run they are the same file. The artifact `deploy-system-lab-plan-<run id>` holds `ledger.json` and `summary.md`. Go on only when:
- `outcome` is `planned`;
- `refusals` is empty;
- `stepPlan` runs the steps you expect (a dry run with nothing to deploy is still `planned`, with every step `skip`);
- G1–G9 all pass (G1–G5 are the gate above; G6 is the ERP image attestation from `build-erp-image.yml`; G7 is the `aws-lab` required reviewer; G8 is the live lab check of step 1; G9 is the live-state record of step 1a);
- `environmentGate` is `reviewed`.

The `backend-core/` folder in the artifact holds the Backend-Core verifier's own ledger, with its reasons when the plan was refused.

### 4. Live run

Dispatch the same inputs with `-f dry_run=false` (and `-f force_all=true` to prove the path). The preflight runs again. Then the live job waits for the `aws-lab` reviewer: open the run, choose **Review deployments**, then **Approve and deploy**. The job then sends the steps of the plan, skipping the others:

| Step | Document | Host | What changes | Completion line |
| --- | --- | --- | --- | --- |
| `backup` | `RT-BackendLabBackup` | lab-02 | a new dump under `/var/backups/rt-lab`, restore-rehearsed | `RT_BACKUP name=… sha256=…` |
| `backend` | `RT-BackendLabDeploy` | lab-01 | wrapper and env, migrate, `api` and `worker`, under a 15-minute auto-revert | `RT_DONE release=<tag>` |
| `console` | `RT-ConsoleLabDeploy` | lab-01 | the `current` symlink (`RT_SWAP unchanged` for the same release) | `RT_DONE release=<tag>` |
| `erp` | `RT-ErpLabDeploy` | lab-03 | an ERP backup, the image, migrate; the workers stop and resume | `RT_OUTCOME=deployed` |

On 2026-11-01 a same-version run (all four steps, before RT-1085) took about 2 minutes of preflight and 5 minutes of live job, of which the ERP step took about 4. With `force_all=true`, a run still writes a lab-02 dump and an ERP backup, and stops and resumes the ERP workers once, even with no version change. Without it, an unchanged product's document is not sent at all.

### 5. Read the live ledger

The artifact `deploy-system-lab-live-ledger-<run id>` holds:
- `outcome`: `deployed` or `failed-at:<step>`;
- `failure`;
- the gate results;
- `runSteps`: the steps the verified plan ran;
- for each step: `state` (`ok`, `failed`, `not-run`, or `skipped` when the plan did not run it), `prior`, `target`, its gates and its strict `RT_*` lines;
- `manualRollback`.

A `skipped` step changed nothing on its host. G8 ignores it and reads older runs until it finds the product's last real deploy, whether by a system run or by its own workflow. A same-version run with `force_all=true` is proven when the outcome is `deployed` and each step shows no version change:
- `backend`: `prior.sentry_release` equals the target tag without `backend-core/`, and the `RT_PRIOR` and `RT_TARGET` digests are equal;
- `console`: its lines hold `RT_SWAP unchanged current=…`;
- `erp`: `RT_DIGEST_AFTER` equals the manifest digest. Its `prior` comes from `current_manifest`, so it is declared, not measured; the document checks it on lab-03.

### 6. When a step fails

The job stops, and later steps do not run. The failing step behaves as its own document does today:
- `backend` refuses at a gate before any change, or reverts itself through the auto-revert. That revert is app-only, and only when `rollbackAllowed` is `true`.
- `console` swaps back on a failed smoke. If its lines show `RT_REVERT failed current=…`, the swap-back itself failed and the Console still serves the new release. Point lab-01's `current` back to the previous release by hand. `manualRollback` does not list the Console then, because the step never finished.
- `erp` can stop after its swap with the workers down. In that case, read the ERP document's ledger on lab-03. Once the scheduler has resumed, `integrations/erpnext-connector/deploy/lab/restore.sh` refuses, whatever the rollback class: the ledger has `resumedAt`, or the host's resume marker is newer than the run. Only a forward fix is then possible, by redeploying with `deploy-erp-lab.yml`. Before any resume, follow the Connector deploy README: for `image-only`, redeploy the previous image; otherwise, or if that fails, run `restore.sh <run id>` as root on lab-03. The run ID is the `deploy-system-lab.yml` run's, the folder under `/var/backups/rt-erp/` that holds its backup.

Earlier steps are not reverted automatically, because a Backend-Core rollback can touch the database. `manualRollback` gives the exact workflow inputs for each step that finished, in the order they can run: ERP, then Backend-Core, then Console. The Console comes last because its document checks that lab-01 runs the Backend-Core release it is given.

Refusals seen so far:

| Line | Meaning | Action |
| --- | --- | --- |
| `G8 FAIL: <product>: the live lab runs …` (preflight) | `current_manifest` is stale, or a newer run left the host unreconciled | step 1 |
| `G9 FAIL: record: …` (preflight) | the live-state record is missing, unreadable, invalid, names no (or several) manifests, has a product in doubt, or `current_manifest` is not the file it names | step 1a |
| `live-state: … changed since the preflight read it` (live job, before any document) | the record changed after the dry run | run a new dry run |
| `live-state: a previous run left … in doubt` (live job) | a `dirty` or `inflight` product | step 1a, Recovery |
| `nothing to deploy: every product is unchanged between the manifests` (preflight, live run) | the two files name the same versions | choose the right files (step 2), or set `force_all=true` to prove the path |
| `G-Host reason=wrapper-does-not-use-the-current-release` | `current_manifest` is stale and G8 could not see it (G8 reads ledgers, not hosts) | step 1 |
| `G-Host reason=an-earlier-auto-revert-is-armed-or-elapsed` | an earlier Backend-Core revert unit is still there | the owner checks it (`services/backend-core/deploy/README.md`, Live run) |
| `backup-config reason=next-wrapper-still-uses-the-current-release` | a same-release redeploy on `RT-BackendLabDeploy` older than #218 | the owner updates the document (step 7) |

### 7. Owner-only steps (no agent or CI job does these)

- **Trust policy.** The `job_workflow_ref` list in the monorepo statement of the `rt-gha-aws-lab-deploy` trust policy must name `Kemetra-Labs/Retail-Tower-Erp/.github/workflows/deploy-system-lab.yml@refs/heads/main`. It was added on 2026-11-01. Without it, the live job fails at "Assume the deploy role" before anything reaches a host. To read it back:

  ```bash
  aws iam get-role --role-name rt-gha-aws-lab-deploy --query Role.AssumeRolePolicyDocument --profile <profile>
  ```

- **SSM documents.** After a merged change to any of the four documents, create a new version from the merged file, with the setup identity (never the deploy role, and not root). The workflow always runs the default version, so make the new version the default. Always name the region and profile explicitly. The region is the `AWS_REGION` of the `aws-lab` environment, which is `us-east-1` today.

  ```bash
  aws ssm update-document --name <document> --document-format YAML --content file://<path on main> --document-version '$LATEST' --region us-east-1 --profile <profile>
  aws ssm update-document-default-version --name <document> --document-version <new version> --region us-east-1 --profile <profile>
  ```

  `RT-ErpLabDeploy` is JSON: use `--document-format JSON`. Then check that `DefaultVersion` equals `LatestVersion`: `aws ssm describe-document --name <document> --region us-east-1 --profile <profile>`.
- **The live-state record.** Created once by the owner, without overwrite, from what the hosts run: `aws ssm put-parameter --name /rt/lab/live-state --type String --value file://record.json --region us-east-1 --profile "$AWS_PROFILE"` (run in the folder that holds `record.json`), then read back (`get-parameter`) to compare the version and the value. Re-seeding after a multi-product doubt is the same command with `--overwrite`, after reading the hosts. Use a non-root identity. The roles are `rt-gha-aws-lab-state-read` (`ssm:GetParameter` on this parameter only) for the preflight and `rt-gha-aws-lab-deploy` (`GetParameter` and `PutParameter`, inside its permissions boundary) for the live jobs; the repository variable is `AWS_STATE_READ_ROLE_ARN`.
- **Approval.** The `aws-lab` approval is the human gate of every live run.

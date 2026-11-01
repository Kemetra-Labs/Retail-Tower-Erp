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
- `current_manifest`: the version live now. For a same-version redeploy it is the same file.
- `jira_key`.
- `dry_run`: defaults to `true`.

The preflight runs the gate above on both files, plus the online checks of each product and G8 (the live lab check, step 1), and writes a planned system ledger. It touches no AWS resource. A live run needs one `aws-lab` approval, then sends four SSM documents in order and stops at the first failure. The ledgers are built by `.github/release/system_ledger.py`. First proven live on 2026-11-01: [run 41306750385](https://github.com/Kemetra-Labs/Retail-Tower-Erp/actions/runs/41306750385), RT-1032.

### 1. Find the version live now

`current_manifest` must describe what each host runs. Any per-product deploy moves the lab and makes the current manifest stale: `deploy-lab.yml` (Backend-Core), `deploy-console-lab.yml` (Console) and `deploy-erp-lab.yml` (ERPNext + Connector).

**The preflight checks this for you (G8, `.github/release/live_check.py`).** With the read-only `actions: read` token it reads the live ledgers of those three workflows and of `deploy-system-lab.yml`, takes for each product the newest deploy that finished (a system run counts for the steps it completed), and compares the Backend-Core release, the Console release and the ERP image digest and commit with `current_manifest`. A mismatch refuses the plan as `G8 FAIL: <product>: the live lab runs <x> (<workflow> run <id>), but the current manifest names <y>`, before the live job and before the lab-02 backup. The new `current_manifest` is the file the refusal points to, or a new file by PR (step 3 below).

G8 also looks at runs newer than the last deploy that did not deploy:
- It **refuses** when the run's ledger shows its host may have changed: a Backend-Core run that got past its `backup-config` gate (it arms the auto-revert next) or has a revert, a Console run that swapped or reverted, any ERP run that held, or that failed after its `check` gate, and a run whose live job started but left no ledger. The owner reconciles the host (see the notes under step 2 below), then a successful deploy of that product with its per-product workflow clears the refusal. There is no override input.
- It records a **note** and passes when the ledger shows the run stopped before it reached a host (for example a Backend-Core run refused at `G-Host`, or a live job that never reached SSM).

G8 also fails closed: when a ledger is missing, expired (artifacts are kept 90 days, so after a quiet quarter run any per-product deploy first), unreadable or malformed, when a workflow has no deployed ledger in its newest 100 runs, or when the token cannot read the runs. G8 proves what the ledgers say was deployed, not what the hosts run: `RT-BackendLabDeploy` G-Host and `RT-ErpLabDeploy` still check the hosts.

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

### 2. Choose the target

| Goal | `manifest` | `current_manifest` |
| --- | --- | --- |
| Prove the path, change no version | the live file | the same file |
| Upgrade | a new file | the live file |

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
- G1–G8 all pass (G1–G5 are the gate above; G6 is the ERP image attestation from `build-erp-image.yml`; G7 is the `aws-lab` required reviewer; G8 is the live lab check of step 1);
- `environmentGate` is `reviewed`.

The `backend-core/` folder in the artifact holds the Backend-Core verifier's own ledger, with its reasons when the plan was refused.

### 4. Live run

Dispatch the same inputs with `-f dry_run=false`. The preflight runs again. Then the live job waits for the `aws-lab` reviewer: open the run, choose **Review deployments**, then **Approve and deploy**. The job then sends:

| Step | Document | Host | What changes | Completion line |
| --- | --- | --- | --- | --- |
| `backup` | `RT-BackendLabBackup` | lab-02 | a new dump under `/var/backups/rt-lab`, restore-rehearsed | `RT_BACKUP name=… sha256=…` |
| `backend` | `RT-BackendLabDeploy` | lab-01 | wrapper and env, migrate, `api` and `worker`, under a 15-minute auto-revert | `RT_DONE release=<tag>` |
| `console` | `RT-ConsoleLabDeploy` | lab-01 | the `current` symlink (`RT_SWAP unchanged` for the same release) | `RT_DONE release=<tag>` |
| `erp` | `RT-ErpLabDeploy` | lab-03 | an ERP backup, the image, migrate; the workers stop and resume | `RT_OUTCOME=deployed` |

On 2026-11-01 a same-version run took about 2 minutes of preflight and 5 minutes of live job, of which the ERP step took about 4. Even with no version change, it writes a lab-02 dump and an ERP backup, and stops and resumes the ERP workers once.

### 5. Read the live ledger

The artifact `deploy-system-lab-live-ledger-<run id>` holds:
- `outcome`: `deployed` or `failed-at:<step>`;
- `failure`;
- the gate results;
- for each step: `state` (`ok`, `failed` or `not-run`), `prior`, `target`, its gates and its strict `RT_*` lines;
- `manualRollback`.

A same-version run is proven when the outcome is `deployed` and each step shows no version change:
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
- **Approval.** The `aws-lab` approval is the human gate of every live run.

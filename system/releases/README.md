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

## Deploying a system version

`.github/workflows/deploy-system-lab.yml` (RT-1031) takes `manifest` (the version to deploy), `current_manifest` (the version live now; the same file for a same-version redeploy), `jira_key` and `dry_run` (default `true`). Its preflight runs the gate above on both files plus the online checks, and uploads a planned system ledger. A live run (one `aws-lab` approval) sends four SSM documents in order: `RT-BackendLabBackup` on lab-02, `RT-BackendLabDeploy` on lab-01, `RT-ConsoleLabDeploy` on lab-01, `RT-ErpLabDeploy` on lab-03. It stops at the first failure; the system ledger then lists the manual rollback inputs of each step that finished (`.github/release/system_ledger.py`).

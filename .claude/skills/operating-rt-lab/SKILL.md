---
name: operating-rt-lab
description: Use when reading, verifying, deploying to or debugging the Retail Tower AWS lab (lab-01, lab-02, lab-03, the rt9 lab tenant) — which versions run there, /rt/lab/live-state, deploy-system-lab, SSM Run Command, Datadog "No Data" for the lab, a GitHub OIDC trust policy for an AWS role, running the packaged POS against the lab, a Cloudflare 403 on a lab hostname, provisioning synthetic cashiers with the lab-fixtures CLI, or running k6 load tests against the lab.
---

# Operating the RT lab

## Overview

The lab is the owner's non-production AWS environment. It is real infrastructure under the owner's
root credentials, so every host action needs the owner's yes, and every result is labelled with
where it came from. The release procedure itself is in `system/releases/README.md`; reusable lab
procedures are child pages of the Confluence "Lab and Bench Runbook" (page 18874418).

**Related:** `aws-core:aws-iam` (trust policies), `driving-electron-via-cdp` (driving the POS UI),
`troubleshooting-windows-dev` (Git Bash path traps), `executing-rt-issue` (where evidence goes).

## The lab

- SSM-managed hybrid nodes in us-east-1, found by SSM tag `Host=`: **lab-01** Backend-Core
  (`dp2-api`, `dp2-worker`, caddy, redis, Datadog agent), **lab-02** Postgres and backups,
  **lab-03** ERPNext v16 (compose project `rt-erp`, site `lab.localhost`).
- **rt9** is the lab tenant and store, not a host.
- AWS CLI: use only the IAM-user profile `rt-readonly`; never root, the `default` profile, or an MCP
  server that signs in as root (check `aws sts get-caller-identity` first; stop and say so if it
  shows root). In Git Bash, any `/rt/...` name needs `MSYS_NO_PATHCONV=1` or it reads as missing.
- Poll SSM with `aws ssm get-command-invocation ... 2>$null | ConvertFrom-Json` in PowerShell, so
  stderr noise does not break the JSON.

## Reaching the lab from outside

- The public hostnames sit behind Cloudflare with Bot Fight Mode on. Server-to-server callers
  (the ERPNext connector on lab-03) need an owner-made IP Access **Allow** rule; never turn Bot
  Fight Mode off or change Cloudflare rules yourself.
- Probe with `curl -4`: a Windows client may go out over IPv6, which the IPv4 allow rule does not
  cover, and the resulting 403 is not a lab fault.
- The connector's Backend-Core base URL must be `https://` (an `http://` URL is refused).

## Rules for host access

- SSM Run Command is an action on the host: name the hosts and exact commands, get the owner's yes,
  keep commands read-only.
- Never print secrets: never `cat` ERPNext `site_config.json` / `common_site_config.json`; read one
  env var with `docker inspect <c> --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E '^NAME='`.
- Generate SSM `--parameters` JSON with a script (`json.dump`), never a hand-escaped heredoc.
- Evidence from a local WSL bench is labelled "local disposable bench", never "lab" or "rt9".

## "What runs on the lab?"

Report three sources separately; only the third proves the hosts:
1. **Record:** the newest live ledger of `deploy-lab`, `deploy-console-lab`, `deploy-erp-lab`,
   `deploy-system-lab` (`gh run download`; 90-day retention).
2. **State record:** SSM `/rt/lab/live-state` (version, per-product status, `inflight` or `dirty`).
3. **Host-observed:** read-only `docker ps` and the `org.opencontainers.image.revision` labels via
   SSM; for the Console (static files, no container) read `readlink /opt/dp2-console/current` and
   that release's `version.json` (`sha`, `backendContractPin`) on lab-01.
If they disagree, report it; do not resolve it yourself.

## `/rt/lab/live-state`

Written only by live lab deploys (begin `inflight`, finish with the ledger outcome). Agents never
write, delete or re-seed it. A `dirty` or `inflight` product is cleared by a ledger-proven deploy
of that product or by the owner (README steps 1a and 7).

## System deploys (`deploy-system-lab.yml`)

- A new combination is a new `system/releases/lab-YYYY.MM.N.json` (draft with
  `.github/release/draft_manifest.py`), merged by PR; never edit a deployed manifest.
- Leave `current_manifest` empty: gate G9 resolves it from the live-state record. A wrong value is refused.
- A Backend-Core release usually needs a Console release whose PIN equals that commit (G3).
- The POS compatibility fleet baseline must be under 7 days old, or `FAIL_STALE_FLEET` refuses.
- Dry run first; the live run needs the owner's `aws-lab` approval. New required env keys on lab-01
  and SSM document or IAM changes are owner steps.

## Datadog "No Data" is not "lab down"

The lab agent sends to the **EU** site (`datadoghq.eu`), and since RT-1276 so do the repo defaults
(`DD_SITE` in `docker-compose.prod.yml`, `prod.env.example` and `deploy/datadog/apply.mjs`); an
explicit `DD_SITE` still wins. Older connector setups and monitors may still point at the old us5
org, which receives nothing. Before concluding anything, confirm the reader is on the EU org
(hosts include `retail-tower-lab-01`) and, with the owner's yes, read the agent's `DD_SITE` only.

## GitHub OIDC trust for an AWS role

The repo's `sub` is the immutable form
`repo:Kemetra-Labs@340160100/Retail-Tower-Erp@1430288487:<ref or environment:NAME>`; the plain
`repo:Kemetra-Labs/Retail-Tower-Erp:...` form fails. Copy the claim set the deploy role uses
(`services/backend-core/deploy/lab/oidc-claims-check.cjs`): pin `repository_id`,
`repository_owner_id`, `job_workflow_ref`, and `environment` only for jobs that have one. The owner
applies IAM changes.

## Packaged POS against the lab

- Do not build it locally (native modules need Visual Studio C++ tools). Use the CI artifact
  `pos-pulse-win-unpacked-<sha>` from `pos.yml` (main pushes only, kept 1 day):
  `gh run download <run-id> -n pos-pulse-win-unpacked-<sha> -D <new empty dir>`.
- Set `VITE_API_BASE_URL` to the lab API endpoint (ask the owner for it) as a process-scope env
  var; unset, the app uses `https://example.invalid` and cannot pair.
- Launch with process-scope env vars only (never `setx`) and a fresh `--user-data-dir` under a
  short root such as `C:\rt\<name>` (a Windows absolute path; do not rely on 8.3 conversion, which
  returns the long path when no 8.3 name exists). Create the directory, confirm the launch user can
  write to it, and keep the whole path under 60 characters (a conservative bound below the
  260-character Windows limit, not a measured Chromium limit); stop and do not launch if any fails. A path Electron cannot create (too
  long or denied) is silently ignored and the app opens the owner's real `%APPDATA%\pos-pulse`
  profile, running migrations on it at startup, before any later check can catch it.
- Before any interaction, verify isolation: the scratch dir gains `pos-pulse.db`, and the real
  profile's files do not change.
- Check which identity-provider env names the lab expects (names only) before preparing sign-in.
  The POS needs, as process-scope env vars, `VITE_API_BASE_URL`, `DESCOPE_PROJECT_ID` (without it
  every sign-in fails with "invalid credentials") and the `POS_PULSE_FEATURE_*` flags for the flows
  under test (`CART`, `PRODUCT_SEARCH`, `PAYMENTS`, `SALE_FINALIZATION` set to `1`; the cart stays
  disabled without them). Set the flags not under test to `0`.
- The cashier roster shows only cashiers with access to the till's store. A till on a store with no
  ERP mapping captures sales that the connector rejects as `unmapped_store`.

## Cashier admission and synthetic cashiers

- A cashier holds one active admission at a time; a second terminal gets `active_elsewhere`. Sign
  the cashier out from the POS ("خروج", reason `device_end`) before a k6 run reuses them; closing
  the app does not end the admission. Admissions expire after 12 hours.
- Synthetic cashiers come only from the guarded lab-fixtures CLI (RT-1309), never from direct DB
  writes or the Console: `docker exec -e RT_LAB_FIXTURES=enabled dp2-api node
  dist/cli/lab-fixtures.js status|provision [--dry-run] --tenant <id> --store <id> --count <n>`.
  It refuses outside database `rtlab`, an allow-listed synthetic tenant and a Descope test project.
  Run `--dry-run` first; `provision` needs the owner's yes and a non-empty
  `DESCOPE_MANAGEMENT_KEY` on lab-01 (an owner step). Descope test users need an email or phone
  (`E011002`); fixtures use `@fixtures.invalid`, which needs Backend-Core with #492.

## Reading ERPNext rows and logs on lab-03 (read-only, with the owner's yes)

Found in RT-1351, where the A1c rejection had to be explained from the host:
- Host: find the instance with `aws ssm list-tags-for-resource --resource-type ManagedInstance`
  (tag `Host=lab-03`). Run `AWS-RunShellScript` with the `rt-readonly` profile.
- Send one script, not many commands: base64 the shell script and the Python script (`echo <b64> |
  base64 -d | bash`) so no quoting survives to SSM. Output is capped near 24 000 characters:
  `head` and `cut` every section.
- Query through the backend container, not `bench mariadb` quoting:
  `docker exec -i <rt-erp backend> bash -c 'cd /home/frappe/frappe-bench/sites && ../env/bin/python -'`
  with a script that does `frappe.init(site="lab.localhost", sites_path=".")`, `frappe.connect()` and
  `SET SESSION TRANSACTION READ ONLY` first. In `frappe.db.sql` strings, `%` breaks without
  parameters (`not all arguments converted`): use `left()`, `locate()` and `mod()` instead of `LIKE '%…'`.
- Logs are in `/home/frappe/frappe-bench/logs/` and shared by every `rt-erp-*` container; the posting
  events are in `retail_tower_posting.log`. Only ERROR-level events survive (RT-409), so a posted sale
  leaves no line there: its proof is the Posting Log row and the Sales Invoice.
- `Scheduled Job Log` is empty for the posting poller (`create_log` is 0). The scheduler's
  "Skipped queueing … found in queue" lines in `scheduler.log` are how Frappe prevents two runs of one job.
- Datadog EU holds no lab-03 logs (the agent covers lab-01), so an empty Datadog search proves nothing.

## k6 against the lab

- Run the harness in `services/backend-core/loadtests/k6` with `grafana/k6` in Docker under
  `op run`, so terminal tokens stay in 1Password (`op://...` references, never values).
- Start with one sale (1 VU, 1 iteration) and prove the whole path: capture `201`, one row in
  Backend-Core, `posted` with a `document_ref`, exactly one ERPNext Sales Invoice, no new Sentry
  issue. Only then scale.
- `LOAD_UNIT` must be a UOM that exists in ERPNext (default `unit`); an unknown one fails posting
  with `UnmappedUnit`, which looks like a stock problem but is not.

## Common mistakes

- Answering "what runs" from memory or from the ledger alone.
- Reporting a deleted parameter from a Git Bash read.
- Setting `current_manifest` by hand.
- A long `--user-data-dir` path.
- Launching the POS without `DESCOPE_PROJECT_ID` or the feature flags.
- Reading a Cloudflare 403 from an IPv6 probe as a lab fault.
- Starting a k6 run while the cashier is still signed in on a POS till.

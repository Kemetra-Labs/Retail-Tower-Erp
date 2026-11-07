---
name: operating-rt-lab
description: Use when reading, verifying, deploying to or debugging the Retail Tower AWS lab (lab-01, lab-02, lab-03, the rt9 lab tenant) — which versions run there, /rt/lab/live-state, deploy-system-lab, SSM Run Command, Datadog "No Data" for the lab, a GitHub OIDC trust policy for an AWS role, or running the packaged POS against the lab.
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
- AWS CLI profile `rt` (owner's choice; root). Prefer the aws-mcp `run_script` tool; in Git Bash,
  any `/rt/...` name needs `MSYS_NO_PATHCONV=1` or it reads as missing.

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

The lab agent sends to the **EU** site (`datadoghq.eu`). Older connector setups, monitors and repo
defaults (`DD_SITE` default `us5.datadoghq.com` in `docker-compose.prod.yml`) still point at the old
us5 org, which receives nothing. Before concluding anything, confirm the reader is on the EU org
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
  returns the long path when no 8.3 name exists). Check the final path's length before launch. A
  long path is silently ignored and the app opens the owner's real `%APPDATA%\pos-pulse` profile,
  running migrations on it.
- Before any interaction, verify isolation: the scratch dir gains `pos-pulse.db`, and the real
  profile's files do not change.
- Check which identity-provider env names the lab expects (names only) before preparing sign-in.

## Common mistakes

- Answering "what runs" from memory or from the ledger alone.
- Reporting a deleted parameter from a Git Bash read.
- Setting `current_manifest` by hand.
- A long `--user-data-dir` path.

---
name: troubleshooting-windows-dev
description: Use when a local command, install, lint or test fails on a Windows checkout or .claude/worktrees worktree of Retail-Tower-Erp — "#module-evaluator", ELIFECYCLE -4058, "'jest' is not recognized", "Cannot find module '@data-pulse-2/...'", Biome format diffs on hundreds of files, hundreds of Connector pytest failures, a false ParameterNotFound, "Filename too long", Playwright "Executable doesn't exist" — or before reporting any local failure as a code defect.
---

# Troubleshooting Windows dev

## Overview

Most local failures on this Windows setup are environment, not code. Before you call anything a
regression: compare against a clean `origin/main` (a detached `git worktree`, never a stash; the
stash is shared across sessions). Compare the underlying cause, not only the boundary or the
error text: both can match for different reasons (an HTTP 500 from a missing database on `main`,
from a bug on the branch). If clean `main` fails with the same cause, it predates your change: call
it an **environment failure** only when the evidence supports it (a symptom in the table below, or
the same check passing on CI), otherwise report it as pre-existing. If the branch fails at a
different point, or the causes cannot be told apart, report it as inconclusive and check that
failure on clean `main` too (an earlier failure there may mask it). If clean `main` passes, report
the comparison and the first failing boundary, not an environment failure. Heavy suites run on CI (`merging-rt-pull-requests`), not here.

Docker lives only in WSL Ubuntu. Git Bash rewrites any argument that starts with `/`
(`/rt/lab/x`, `/mnt/c/...`, `origin/main:path`) into a Windows path.

## Symptom → fix

| Symptom | Cause | Fix |
|---|---|---|
| `vitest --version` works, `vitest run` dies with `ERR_PACKAGE_IMPORT_NOT_DEFINED "#module-evaluator"` in a worktree | pnpm virtual-store path under the long worktree path passes MAX_PATH (260) | `rm -rf node_modules; pnpm install --frozen-lockfile --virtual-store-dir=<short root, e.g. C:/w/v>` (lockfile unchanged). `subst` does not help |
| `pnpm install` ends `@nestjs/core postinstall … ELIFECYCLE -4058`; then `'jest' is not recognized` or `Cannot find module '@data-pulse-2/auth'` | `opencollective \|\| exit 0` fails under Windows cmd; install aborts before `.bin` and workspace `dist` | `pnpm install --frozen-lockfile --ignore-scripts`, then build `@data-pulse-2/shared`, `db`, `auth` in that order; run jest from `apps/api` |
| Backend-Core DB specs, `auth.service`, `session.repository`, `deploy/redis-restart` fail locally | No Docker on Windows | Expected; same on `origin/main`. `MIGRATION_TEST_ALLOW_SKIP=1` makes DB specs report success without running: never cite that as proof |
| `auth-contract-cleanup` spec fails | It fails on any dirty tree | Re-run after committing |
| `biome check` shows format diffs on hundreds of files, untouched ones too | `core.autocrlf=true`: CRLF working tree, LF index | Copy only your changed files to a scratch dir with `tr -d '\r'`, copy `biome.json`, run the repo's `node_modules/.bin/biome check .` there. Report "changed files clean on an LF copy", never "lint green" |
| `biome check --write <folder>` reports "Fixed 100+ files"; `git status` lists files you never touched (RT-1316) | Same CRLF checkout: `--write` rewrites every file it visits to LF | Pass `--write` only your changed files (`git status --short` list). If it already ran, `git checkout -- <file>` each file you did not change, and diff the rest |
| Console `pnpm code-health` shows lower `jscpdClones` / `jscpdDuplicatedLines` and says "run `pnpm code-health:update`"; CI then fails `admin/build-test` with "jscpdClones is 92, baseline is 89" (RT-1316) | jscpd counts clones differently on the CRLF checkout, so the local drop is not real | Never lower the jscpd baseline from a Windows run; keep `main`'s jscpd values and let CI lower them. Knip counts did match CI |
| Console `release-artifact` "passes when no root env file sets VITE_API_BASE_URL" fails locally, on clean `main` too (RT-1316) | `VITE_API_BASE_URL` is exported in this laptop's shell, so the release-env check sees it | `unset VITE_API_BASE_URL` for that run and for any local `vite build`. Not a code defect |
| Arabic strings lose shadda or tashkeel after a Biome fix | Biome **stdin** mode (`--stdin-file-path`) rewrites diacritics on Windows | Never copy stdin output back over Arabic-bearing files; re-read them after any `--fix`. Python edits: `open(p, encoding='utf8', newline='')` |
| A Node test that parses repo YAML or text passes on Linux, fails locally | CRLF in the checkout | Normalise with `.replace(/\r\n/g, "\n")` in the helper |
| ~230 Connector pytest failures on clean `main` too | Windows environment; `pylock.toml` holds Linux wheels only | Run in WSL: `MSYS_NO_PATHCONV=1 wsl -d Ubuntu -- bash /mnt/c/<script>.sh`, where the script does `uv venv` and `uv pip install --require-hashes --no-build -r pylock.toml`, then pytest. Never quote Windows counts as evidence |
| `aws ssm get-parameter --name /rt/lab/...` says `ParameterNotFound` while a workflow wrote it | Git Bash rewrote the leading `/` | `MSYS_NO_PATHCONV=1` on the same command (or PowerShell). A read that contradicts a workflow run is a tooling suspect, never a finding |
| `wsl -d Ubuntu -- bash /mnt/c/...` says "No such file" | Same path rewrite | `MSYS_NO_PATHCONV=1`; put multi-line logic in a script file, never nested quotes through `wsl` |
| Testcontainers "Health check not healthy after 120000ms"; `/tmp` logs vanish | WSL stops dockerd between one-shot `wsl` calls | Hold `wsl -d Ubuntu -- bash -c 'exec sleep 7200'` as a background task; `--runInBand`; logs under `~` |
| `git clone … Filename too long` into the scratchpad | Scratchpad root is ~250 characters | Use the existing checkout, or clone to a short root with `git -c core.longpaths=true clone` |
| Playwright `Executable doesn't exist … chromium_headless_shell-NNNN` | Installed browser build differs from the pinned one | A throwaway untracked config that spreads the repo config and sets `launchOptions.executablePath` to the installed build; delete it after. Downloading browsers needs the owner's yes |
| `tar` from `C:/…` extracts nothing ("Cannot connect to C:") | GNU tar reads `C:` as a remote host | `tar --force-local …` and check the extraction |
| `git archive HEAD:<subdir>` gives an empty archive in CI | Run from inside that subdir | `git -C "$GITHUB_WORKSPACE" archive HEAD:<subdir>` |
| Electron with `--user-data-dir=<long path>` touches the owner's real profile | Chromium ignores an over-long path and falls back to `%APPDATA%` | Use a short root such as `C:\rt\<name>` (not an 8.3 conversion) and check its length before launch; verify the scratch profile gained its DB before interacting (see `driving-electron-via-cdp`) |

## Common mistakes

- Calling a local failure a regression without a clean-`main` comparison.
- Reporting "the parameter was deleted" from a Git Bash read.
- Saying "lint green" from a CRLF checkout.

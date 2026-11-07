---
name: reconciling-rt-jira-with-github
description: Use when reconciling Retail Tower Jira (project RT) with GitHub (Kemetra-Labs/Retail-Tower-Erp), when asked to "close what's done", sweep or clean up In Review issues, check whether RT issues match merged PRs, move stale To Do or In Progress issues, set the Closeout Gate, find stale blocker links, or build an owner input sheet of what each open RT issue still needs. Also use when an owner says "close RT-XXXX, it's merged".
---

# Reconciling RT Jira with GitHub

## Overview

A merged PR is evidence, not completion. An RT issue closes only when every acceptance
criterion is proven by evidence you have read yourself, and only when the owner has
authorized closeouts in the current chat. Authority rules live in the Retail Tower
Operating System (Confluence RETAIL page 6750210, sections 3, 4A, 5A, 11B) and in the
repo `CLAUDE.md` section 13. Read them once per session; this skill does not restate them.

What this skill adds: the evidence checklist that keeps triage honest, the exact Jira
mechanics, a script that does the GitHub side in bulk, and templates for comments,
the mutation log and the owner input sheet.

**Related skills:** `twg-jira` (Jira reads and writes, transitions),
`twg-engineering-work` (issue-to-PR lookup through workitem context),
`twg-jira-resolve-merged-work` (the general merged-work method this specializes),
`superpowers:verification-before-completion` (readback before any claim).

## When to Use

- "Reconcile Jira with GitHub", "close what's done", "full scan", "next wave".
- An owner names issues to close because their PRs merged.
- Moving To Do or In Progress issues whose work has merged.
- Cleaning up "is blocked by" links that point at Done issues.

Not for: implementing an issue (use `Execute RT-XX` and the repo rules), or creating new
issues (apply OS section 4A directly).

## Workflow

1. **Scope and authority.** Default to a dry run. Mutate only after the owner authorizes,
   in this chat, the specific kind of change (transition, close, comment, link removal).
   Each kind needs its own yes. Closes and link deletions also need the owner's approval
   of the exact list: present each issue (or link) with a one-line evidence summary and
   wait for a yes on that list. The agent produces evidence; the owner decides Done
   (CLAUDE.md section 13).
2. **Gather in bulk, not per issue.** Pull all candidate issues with one JQL query
   (results spill to a file; parse the file). Run `python -X utf8 scripts/rt_reconcile.py`
   for the GitHub side: own PRs per key, newest completed `required` per head, push runs
   on merge commits, reverts. See the script's `--help`. Comments are the largest
   payload: fetch them per issue, and only for candidates that have own merged PRs.
3. **Read the evidence for each candidate, in this order** (the order matters: later
   steps often overturn earlier guesses):
   1. Acceptance criteria and evidence contract in the description.
   2. **Every comment.** Owner decisions, exceptions, waivers, run IDs and evidence are
      often already recorded there. Skipping comments produces false "needs evidence"
      verdicts.
   3. Own PRs only: the issue key that comes first in the PR title (else the branch).
      A PR that merely mentions a key belongs to its first key, not to every key named.
   4. The PR file list: captures (`*.png`), specs, migrations, docs named by the criteria.
   5. The newest `required` check-run on each PR head by `started_at` (CLAUDE.md 11.6).
      If it is completed and green, older runs stuck `in_progress` are superseded
      duplicates. If the newest run is itself unfinished, there is no green result.
      `gh pr checks` alone misleads.
   6. If no completed green `required` exists: count CI only with an owner acceptance
      you can attribute to the owner (see below), plus green push runs on the merge commit.
   7. Reverts of the PR on `origin/main`.
4. **Decide per issue** with the table below. Never decide from keywords in the criteria
   ("lab", "captures") without doing step 3.
5. **Act** (only what was authorized), then **read back** every changed issue in one
   query and record each change in the mutation log.
6. **Report**: what changed, what stays open and the exact missing fact for each, and
   the owner decisions that would unlock the next closeouts.

## Decision Table

| Situation after step 3 | Action |
|---|---|
| Every criterion proven; CI green (or owner-accepted) | Evidence comment, set gate, Done, read back |
| A criterion met by a different proof than written | Comment the deviation; ask the owner; do not close |
| A criterion needs staging, lab, packaged run, captures or Sentry action you cannot see | Leave open; comment only if you can name the missing fact and no comment already says it |
| Work Mode Verification | Never close on PR evidence |
| Planning item, artifact merged, owner decision pending | Move to In Review at most |
| To Do or In Progress with own merged PRs, series unfinished | Move to In Progress |
| To Do or In Progress, all planned PRs merged, evidence outstanding | Move to In Review |
| Owner confirms a decision in chat | Record it on the issue (quote date and wording; a comment, so it needs comment authorization), then re-check |

Accepting an earlier CI gate covers CI evidence only. It never waives captures, staging,
lab runs or owner decisions named in the criteria.

## Owner Decisions and New Evidence

**Who decided.** Agents post under the owner's Jira accounts too, so a comment's author
proves nothing. An owner decision counts when the owner states it in the current chat,
or when a comment records the owner's decision with its date and wording and no later
comment contradicts it. If a later comment says the proof is still pending, or you
cannot tell who decided, ask the owner before you close.

**Evidence you produce.** A measurement you take during reconciliation (a CodeScene
score, a grep, a re-run test) can prove an objective criterion when it is reproducible:
re-check it once, then record the method and the result in the closeout comment. It
cannot prove what had to happen before the merge (tests written and passing before a
split), and it never replaces staging, lab, packaged or visual criteria. When your
measurement is the only proof for a criterion, say so in the report so the owner can
see it before you close.

## Quick Reference

| Need | Where |
|---|---|
| Jira IDs, fields, transitions, gate behavior | `references/jira-mechanics.md` |
| Evidence comment, decision comment, log, input sheet | `references/templates.md` |
| Bulk GitHub evidence | `scripts/rt_reconcile.py --help` |

## Common Mistakes

| Mistake | Fix |
|---|---|
| Triage by keywords in the criteria | Read every comment and the PR file list first |
| Crediting a PR to every key in its title | Primary key only (first key in title, else branch) |
| Trusting `gh pr checks` or the merged state | Newest `required` run on the head SHA, by `started_at` |
| Counting a revert PR as more merged work | The script tags titles starting `Revert`; exclude them |
| Looking for a Done transition before setting the gate | Done (41) appears only after the gate is `verified` |
| Posting a generic "merged, not verified" comment | Comment only with a specific missing fact or a closeout |
| Claiming a result before reading it back | One readback query of all changed issues |
| Writing scripts as shell heredocs on Windows | Use the bundled script; UTF-8 in and out |

---
name: executing-rt-issue
description: Use when asked to "Execute RT-XX" or to work any Retail Tower Jira (RT) issue end to end, when choosing which skills to use for a Planning, Implementation, Verification or Docs item, when a verification finds a defect, when proposing a follow-up RT issue, or when deciding where evidence, procedures and lessons go.
---

# Executing an RT issue

## Overview

The repo `CLAUDE.md` already holds the hard rules: pre-flight, Work Modes, scope, stop conditions,
Git rules and the final report (sections 6 to 15). Follow it; this skill does not restate it.
This skill adds what `CLAUDE.md` leaves open: which skills to chain for each Work Mode, where each
kind of output lives, and how to propose follow-up work without creating duplicates.

## Skill chain by Work Mode

Read the issue's Work Mode field (`customfield_10135`) first. Then:

| Work Mode | Chain |
|---|---|
| Planning | `superpowers:brainstorming` (options) → evidence from `main`, CI and Jira → `superpowers:writing-plans` when the output is a plan → decision record (see "Where output goes") |
| Implementation | `superpowers:test-driven-development` → **`landing-gated-changes`** if any gated path is touched → `pr-review` in a fresh subagent before the PR → **`merging-rt-pull-requests`** for push, CI and merge |
| Verification | `superpowers:verification-before-completion` throughout; `superpowers:systematic-debugging` to locate a first failing boundary (diagnosis only, no fix); **`operating-rt-lab`** for lab runs |
| Docs | The document is the deliverable; `pr-review` (it reviews docs too) before the PR |

Any mode: **`troubleshooting-windows-dev`** when a local command or test fails for environment reasons.

## Before proposing a follow-up issue

A verification finding, a missing contract or a scope gap often already has an owner.

1. Search first: `searchJiraIssuesUsingJql` with the feature words and the components involved
   (for example `project = RT AND text ~ "release" AND text ~ "POS"`), and read linked issues.
   A Planning issue that is already Done may hold the contract you need.
2. If one exists, point to it. Otherwise draft the new issue to OS §4A (Confluence page 6750210):
   objective, Work Mode, parent Epic, scope and exclusions, acceptance criteria, evidence contract,
   dependencies.
3. Give your §4A.6 assessment of it: PASS, REVISE, BLOCKED or DUPLICATE, with a one-line reason.
4. Create it only when the owner says so in chat.

## Where output goes

| Output | Surface |
|---|---|
| Evidence for this issue (results, SHAs, CI runs, first failing boundary) | A comment on the issue you are executing. Posting it is part of the work (OS §8); it never changes status or the Closeout Gate |
| Reusable lab or bench procedure | A child page of the Confluence "Lab and Bench Runbook" (page 18874418): procedures and lessons only, no secrets; Jira keeps the evidence |
| Planning decision or design | A Confluence page in RETAIL, linked from the issue; mark it a draft until the owner approves |
| A lesson learned while solving an RT problem | The matching repo skill under `.claude/skills/`, in the same PR as the fix, **instead of** the personal `global-lessons.md` (owner decision 2026-11-07, so teammates get it). Only machine-only or cross-project lessons go to the personal file |

## Common mistakes

- Proposing "a new contract-first issue" without searching Jira for one.
- Leaving evidence only in the chat report, where the next session cannot find it.
- Ending an Implementation item at "PR merged" without the post-merge `main` check in `merging-rt-pull-requests`.

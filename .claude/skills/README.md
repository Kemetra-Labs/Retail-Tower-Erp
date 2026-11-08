# Retail Tower repo skills

Claude Code loads these skills for anyone who clones this repository. They hold Retail Tower facts
that official and shared skills cannot know. Jira: RT-1268 (first skill), RT-1270 (this set).

## Catalog

| Skill | Use when | Routes to |
|---|---|---|
| `executing-rt-issue` | "Execute RT-XX"; choosing skills per Work Mode; proposing a follow-up issue; where evidence, procedures and lessons go | `superpowers:*`, `pr-review`, the skills below |
| `merging-rt-pull-requests` | Push, CircleCI preflight, waiting on CI, merge, post-merge checks | `safe-git-pr-workflow`, `pr-comments-triage`, CircleCI `debug-failing-run` |
| `landing-gated-changes` | `.github`, `.circleci`, `tools/project-graph`, contracts, migrations, dependencies, a new top-level folder | CircleCI `write-config`, `nestjs-drizzle-bullmq`, `api-design`, `pr-review` |
| `troubleshooting-windows-dev` | A local command, install, lint or test fails on Windows or in a worktree | `driving-electron-via-cdp` |
| `operating-rt-lab` | The AWS lab: versions, live-state, system deploys, Datadog, OIDC trust, packaged POS | `aws-core:aws-iam`, `driving-electron-via-cdp` |
| `reconciling-rt-jira-with-github` | Reconciling RT Jira with merged work; closeouts | `twg-jira`, `twg-engineering-work` |
| `nestjs-drizzle-bullmq` | Backend-Core NestJS, Drizzle + RLS, BullMQ/outbox, Jest db-integration | — |
| `driving-electron-via-cdp` | Screenshotting or smoke-testing the POS Electron app without the owner | — |
| `ux-pos-console` | Any POS or Admin Console screen, flow, copy, token or accessibility decision | `references/` in the skill |

## Rules for these skills

1. **Overlay rule.** A skill holds only what an official or shared skill cannot know, and names that
   skill (`REQUIRED SUB-SKILL: <name>` or a "Related" line). Never copy another skill's text. If
   deleting the RT lines would leave an official skill that does the job, the skill should not exist.
2. **Lessons go here.** When you solve an RT problem, add the lesson to the matching skill in the
   same PR as the fix, instead of a personal notes file. Machine-only lessons stay personal.
3. **Test before you change.** New skills and edits follow `superpowers:writing-skills`: run the
   scenario without the change first, record what the agent got wrong, then write only against that,
   and re-run. A rule that can contradict an explicit owner instruction must say "stop and ask".
4. **No secrets.** No account credentials, tokens, emails, pairing codes or laptop-specific paths.
5. **Names** follow the official style: verb-ing + object (`landing-gated-changes`).

## Where else skills live

- Cross-project skills (`pr-review`, `pr-comments-triage`, `external-reviewer`) are planned for a
  separate Kemetra plugin repository, enabled per repository (owner decision 2026-11-07).
- Personal `~/.claude/skills` keeps only machine-specific skills. If a personal copy of a skill in
  this folder exists, remove it so only one version is loaded.
- `.claude/skills/**` is the `agent` class in `tools/project-graph/graph.yaml`: changes here select no CI job.

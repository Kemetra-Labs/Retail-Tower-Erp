# Retail Tower repo skills

Claude Code loads these skills for anyone who clones this repository. They hold Retail Tower facts
that official and shared skills cannot know. Jira: RT-1268 (first skill), RT-1270 (this set).

## Catalog

| Skill | Use when | Routes to |
|---|---|---|
| `executing-rt-issue` | "Execute RT-XX"; choosing skills per Work Mode; proposing a follow-up issue; where evidence, procedures and lessons go | `superpowers:*`, `reviewing-pull-requests`, the skills below |
| `merging-rt-pull-requests` | Push, CircleCI preflight, waiting on CI, merge, post-merge checks | `handling-git-and-prs-safely`, `triaging-pr-comments`, CircleCI `debug-failing-run` |
| `landing-gated-changes` | `.github`, `.circleci`, `tools/project-graph`, contracts, migrations, dependencies, a new top-level folder | CircleCI `write-config`, `nestjs-drizzle-bullmq`, `api-design`, `reviewing-pull-requests` |
| `troubleshooting-windows-dev` | A local command, install, lint or test fails on Windows or in a worktree | `driving-electron-via-cdp` |
| `operating-rt-lab` | The AWS lab: versions, live-state, system deploys, Datadog, OIDC trust, packaged POS | `aws-core:aws-iam`, `driving-electron-via-cdp` |
| `reconciling-rt-jira-with-github` | Reconciling RT Jira with merged work; closeouts | `twg-jira`, `twg-engineering-work` |
| `nestjs-drizzle-bullmq` | Backend-Core NestJS, Drizzle + RLS, BullMQ/outbox, Jest db-integration | — |
| `driving-electron-via-cdp` | Screenshotting or smoke-testing the POS Electron app without the owner | — |
| `ux-pos-console` | Any POS or Admin Console screen, flow, copy, token or accessibility decision | `references/` in the skill |
| `reviewing-pull-requests` (general, copied) | Reviewing a branch, diff or PR before push, PR or merge | `requesting-external-review` |
| `triaging-pr-comments` (general, copied) | Addressing or resolving review threads from any reviewer | — |
| `requesting-external-review` (general, copied) | An independent second opinion on code, a plan or a decision | `superpowers:*` |
| `handling-git-and-prs-safely` (general, copied) | Stacked or squash-merged PRs, branch or worktree cleanup, stash, revert | `superpowers:*` |

## Rules for these skills

1. **Overlay rule.** A skill holds only what an official or shared skill cannot know, and names that
   skill (`REQUIRED SUB-SKILL: <name>` or a "Related" line). Never copy another skill's text. If
   deleting the RT lines would leave an official skill that does the job, the skill should not exist.
   **Exception:** the four general skills (`reviewing-pull-requests`, `triaging-pr-comments`,
   `requesting-external-review`, `handling-git-and-prs-safely`) are deliberate copies (see below).
2. **Lessons go here.** When you solve an RT problem, add the lesson to the matching skill in the
   same PR as the fix, instead of a personal notes file. Machine-only lessons stay personal.
3. **Test before you change.** New skills and edits follow `superpowers:writing-skills`: run the
   scenario without the change first, record what the agent got wrong, then write only against that,
   and re-run. A rule that can contradict an explicit owner instruction must say "stop and ask".
4. **No secrets.** No account credentials, tokens, emails, pairing codes or laptop-specific paths.
5. **Names** follow the official style: verb-ing + object (`landing-gated-changes`).
6. **Frontmatter is YAML.** Quote the `description` when it contains `: ` (for example
   `"[GATED: …]"`); unquoted, the YAML breaks and the skill loses its description, so it stops
   triggering.

## Where else skills live

- The four general skills were copied from `Kemetra-Labs/claude-plugins` (`plugins/kemetra-dev`,
  commit `40f2d39`) on the owner's decision of 2026-11-08, so a clone of this repo has them without
  the plugin; linking the plugin here is paused. These copies follow the same rules as every skill
  here: an RT lesson or fix goes into the copy in this repo. If the change is general (not RT-only),
  say so in the PR so the owner can port it to `claude-plugins` too; the two copies can otherwise drift.
- Personal `~/.claude/skills` keeps only machine-specific skills. If a personal copy of a skill in
  this folder exists, remove it so only one version is loaded.
- `.claude/skills/**` is the `agent` class in `tools/project-graph/graph.yaml`: changes here select no CI job.

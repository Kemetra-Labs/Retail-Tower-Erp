# Templates

Write in plain markdown (`contentFormat: markdown`). State only what you read; say "read
from the PR, not re-run" when a number comes from a PR description.

## Evidence comment (closeout)

```markdown
**Evidence reconciliation and closeout, <YYYY-MM-DD> (Claude Code, on the owner's instruction in chat to reconcile Jira with GitHub and close what the evidence supports).** Baseline: `origin/main` `<sha9>`.

**Merged evidence**
* PR [#<n>](https://github.com/Kemetra-Labs/Retail-Tower-Erp/pull/<n>), merge commit `<sha9>` (<date>), head `<sha9>`.
* `required` on that head: newest completed run `success` (GitHub check-runs API). <or: the owner-accepted earlier-gate note, plus the push runs on the merge commit with their run ids>
* No revert of #<n> on `origin/main`.

**Acceptance criteria mapped to evidence**
1. <criterion, short> -> <test name, file, run id or comment id that proves it>
2. ...

**Scope check:** <files touched; no contract/migration change, or the approval that covered it>.

**Out of scope (not claimed):** <what the issue leaves to another issue or to runtime>.

Closeout Gate set to `verified` on this evidence. A merged PR alone was not treated as completion.
```

## Decision or gap comment (no close)

```markdown
**Evidence reconciliation, <YYYY-MM-DD> (Claude Code). Status unchanged (<status>); Closeout Gate not set.**

<What is merged and proven, one or two lines.>

**Why I did not close it:** <the exact unmet criterion and what would prove it>.

**Owner decision needed:** <one question, with the options>.
```

When the owner answers in chat, post a follow-up that quotes the decision with its date,
then either close (evidence comment) or say what is still open.

## Mutation log

Append one tab-separated line per change to a session file (scratchpad), before and after
each step, so a cut session can be recovered:

```text
# time(local)	key	action	before	after
2026-11-07 19:04	RT-1262	comment 15981 (evidence)	-	posted
2026-11-07 19:04	RT-1262	set customfield_10242	pending	verified(10174)
2026-11-07 19:05	RT-1262	transition 41 (Done)	In Review	Done (pending readback)
2026-11-07 20:22	RT-170	DELETED issueLink 10448 (blocked by RT-16, Done)	present	removed
2026-11-07 19:07	READBACK	RT-157,RT-1218	In Review	Done, resolution Done, gate verified
```

For link deletions, log the link ID and the blocker key so the link can be re-created.

## Owner input sheet

One row per open issue, grouped by what unblocks it. Each row names one fact, not a
category. Mark rows you have not examined in detail as such; do not guess.

```markdown
## A. Your decisions
| Issue | Needs |
|---|---|
| RT-1201 <title> | Owner: accept the AST-identity proof for criterion 3, or require something stricter. |

## D. Lab, live, staging or bench proof
| RT-1233 <title> | Staging: force one non-retryable failure and see it in the Console needs-repair list (criterion 3). |
```

Group names that worked: your decisions; Verification items; frozen-repo PRs only or no
PR; lab, live, staging or bench proof; captures, visual or packaged proof; merged without
a green `required`; individually read.

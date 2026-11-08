---
name: requesting-external-review
description: Use when you want an independent adversarial second opinion on code, a plan, a design, a decision or a document before merging, finalizing, or declaring it done, from a reviewer that did not do the work.
---

# Requesting external review

**REQUIRED BACKGROUND:** `superpowers:requesting-code-review` for dispatching a code reviewer.
This skill extends it to decisions, plans and documents, and fixes the verdict contract.

The judge is a fresh subagent with no conversation context, so it cannot rationalize work it
never watched. It judges; it never edits.

## Dispatch

One Agent call: `subagent_type: "general-purpose"` (never `fork`, which inherits the
conversation) and `model: "opus"`. Set `effort` only when the user or repo instructions ask for
a level. The prompt is the judge prompt below with the brackets filled.

WORK UNDER REVIEW contains:
- **Code:** the repo path, base and scope only. The judge runs `git diff`, reads files and greps
  call sites itself. No summary of what you did or why.
- **Decision, plan or document:** the exact claim, the full rationale, and every rejected
  alternative with its reason, as stated in the conversation, plus only the paths and facts the
  user or the conversation actually named.

## Judge prompt

```
You are an independent external reviewer. You did NOT do this work and have no stake in it.
Find what is wrong, missing, or unjustified, and propose concrete fixes. A finding without
evidence is not a finding.

WORK UNDER REVIEW:
<code: repo path, base, scope; inspect it yourself with git diff / Read / Grep>
<decision: exact claim, full rationale, rejected alternatives and why>

SPECIFIC CLAIMS TO STRESS-TEST:
<1-3 claims the author most wants challenged>

1. Check the work against its own goal; name anything asserted without proof.
2. Find gaps: missing cases, unhandled errors, untested paths, unstated assumptions,
   boundary/security/concurrency risks, contradictions.
3. For a decision: give the strongest counterargument and the best alternative not chosen,
   and say what would change your verdict.
4. Rank findings by severity, each with a concrete fix.

Return exactly:
VERDICT: APPROVE | REVISE | REJECT
GAPS (highest severity first):
  [CRITICAL|HIGH|MED|LOW] <finding> — evidence: <file:line / quote / repro> — fix: <change>
MISSED / UNVERIFIED: <what the work did not check or prove>
STRONGEST COUNTERARGUMENT: <best case against this approach>

Default to REVISE or REJECT when uncertain. If you cannot inspect the artifact, return REJECT.
```

## After the verdict

Relay the full verdict, gaps, evidence and fixes; mark any finding you disagree with beside it
rather than dropping it. Then stop: apply fixes only on the user's go-ahead.

# RT Jira mechanics

Verified against the live site on 2026-11-07; notes added later carry their own date. Re-check with a read before relying on an ID
if anything here looks off.

## Site

- Site: `rahmaqanater.atlassian.net`, cloudId `78e4deee-429c-4a88-9c95-38ffe1708bf9`.
- Project `RT`. Workflow: `To Do -> In Progress -> In Review -> Done`.

## Fields

| Field | ID | Values |
|---|---|---|
| Work Mode | `customfield_10135` | Implementation, Verification, Planning, Docs |
| Closeout Gate | `customfield_10242` | `pending` = option `10173`, `verified` = option `10174` |
| Checklist Completed (HeroCoders, legacy) | `customfield_10139` | Do not edit or spoof |

## Transitions

All are global and have no screen.

| ID | To status |
|---|---|
| 11 | To Do |
| 21 | In Progress |
| 31 | In Review |
| 41 | Done (conditional) |

Done is conditional: `Checklist Completed = All Completed` OR `Closeout Gate = verified`.
Before the gate is set, transition 41 is missing from the default list (or shows
`isAvailable: false` with `includeUnavailableTransitions`). Set the gate first, then list
transitions again and use 41. Once the gate is `verified`, 41 is available directly from
To Do or In Progress, so no In Review step is needed (re-checked on 2026-11-10). Some
older issues (for example RT-293 and RT-309) have an empty gate field; setting it works
the same way.

Tasks and Bugs both accept the gate field. Moving an issue out of Done resets the gate to
`pending` asynchronously; reconfirm after any reopen.

## Close sequence

Run only with owner authorization in the current chat and complete evidence.

1. `addCommentToJiraIssue`: the evidence comment (see `templates.md`).
2. `editJiraIssue` with `{"customfield_10242": {"id": "10174"}}`.
3. `getTransitionsForJiraIssue`: confirm 41 is now available.
4. `transitionJiraIssue` with `{"transition": {"id": "41"}}`.
5. Read back status, `resolution` and `customfield_10242` in one JQL query for the whole batch:
   `key in (...)` with `fields: ["status","resolution","customfield_10242"]`.

Pilot one issue end to end before batching the rest.

## Status moves (no close)

Use transition 31 (In Review) or 21 (In Progress) directly, with a comment that cites the
evidence or the owner's confirmation. Never set the gate for a status move.

## Links

- Blocker links have type `Blocks`. On the blocked issue they appear as `inwardIssue`
  ("is blocked by"); the link's `id` is what deletion needs.
- A blocker that is Done is stale. Removal is destructive: get the owner's approval of the
  exact list, log every link ID and its blocker first, delete one and verify, then batch.
- Delete with `twg jira workitem unlink workitem --link-id <id> -s rahmaqanater -o json`
  (look for `success: true`). At the time of writing (2026-11-10) the Atlassian MCP tools
  offered in a Claude Code session had no delete-link operation.
- A link shows on both issues. `outwardIssue` on issue A means A blocks X; when X is
  Done the link is moot. Sweep both directions, plus links to issues you close in the
  same run. Compare the link IDs of every touched issue before and after: the removed
  set must equal the approved set and nothing else may change.
- Duplicates use link type `Duplicate` ("duplicates" outward, "is duplicated by" inward).
  Read it on the issue before closing it as a duplicate.

## Large queries

JQL results over the tool limit are saved to a file. Parse that file with Python
(UTF-8) instead of re-querying. Ask only for the fields you need; `issuelinks`,
`description` and `comment` make results large. Page with `nextPageToken` until
`hasNextPage` is false: the open RT set is over 300 issues.

## Native PR links

The GitHub integration links PRs to issues by key automatically. Check with
`twg context jira workitem <keys...> --relationships jira_work_item_links_external_pull_request`
before adding any manual link.

# connector-mirror (RT-712, decision D3)

`bench get-app` has no subdirectory option: the repo root must be the Frappe app. So the Connector is distributed
from an **append-only mirror** (the existing `Kemetra/ERPNext-Connector`, never archived) whose root is
`integrations/erpnext-connector/` of the monorepo.

`publish.py` (stdlib Python, git >= 2.40) appends, for each first-parent source commit that changes the subtree,
**one** mirror commit:

- tree = `git rev-parse <source-sha>:integrations/erpnext-connector` (equal by construction, then asserted);
- parent = current mirror head; author and message from the source commit, committer is a pinned publisher
  identity with the source commit date, so re-publishing a SHA gives an identical commit;
- bare `#N` references are qualified as `<source-repo>#N` (they would otherwise link to the mirror's own issues);
- trailer `Monorepo-Commit: <source-repo>@<source-sha>` (`--source-repo Kemetra/Retail-Tower` at cutover).

Source tags `erpnext-connector/vX.Y.Z` become lightweight mirror tags `vX.Y.Z` on the matching mirror commit.

Why not `git subtree split` or filter-repo: a regenerated split does not descend from the live repo's history, so
existing benches (`bench update` = `git pull`) would break (blueprint §2.6). Computing one `commit-tree` per
source commit is the smallest thing that keeps the mirror's history continuous.

```bash
python tools/release/connector-mirror/publish.py --mirror <url-or-path> --source-repo Kemetra/Retail-Tower \
    [--source-ref main] [--base <sha>] [--dry-run | --verify]
```

- `--mirror` and `--source-repo` have no default. The mirror must already hold the frozen live `main`.
- First run only: `--base <source sha>` names the commit whose subtree equals the mirror head's tree; any other
  value is refused. Later runs read their state from the last trailer on the mirror, so a re-run is a no-op.
- `--verify` re-checks every published commit (valid source SHA, tree equals subtree, source order monotonic).

## Safety properties (each covered by `tests/test_publish.py`)

- Never forces: one `git push --atomic` with plain refspecs. A mirror that moved after our fetch is rejected as
  non-fast-forward (exit 4) and the next run reconciles; nothing is overwritten.
- Refuses (exit 2) when: the mirror head is not a publisher commit (a hand edit), the recorded provenance is not
  in the source (regenerated history) or not on its first-parent line, `--base` is not the frozen baseline,
  an existing mirror tag would move, or any published tree differs from its source subtree.
- Out-of-order or stale triggers: the source ref is walked in ancestry order, so an older head is a no-op.
- Concurrent publishers produce identical commits (deterministic), so they converge on one linear history.
- The mirror's URL, credentials and the publisher GitHub App are out of scope here: this tool takes a URL and
  uses whatever git credentials the caller provides. It is not wired into CI.

## Tests

```bash
python -m pytest tools/release/connector-mirror/tests -q     # offline, ~25 s
bash tools/release/connector-mirror/bench-proof.sh 15|16 <throwaway-source-clone> <base-sha> <frozen-mirror-bare> <workdir>
```

`bench-proof.sh` needs Docker and runs `frappe/erpnext:v15` or `:v16` with mariadb and redis on a private
network, cloning a local copy of the mirror through `bench get-app file:///...`. It never touches a real remote.

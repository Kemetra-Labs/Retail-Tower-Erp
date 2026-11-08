---
name: handling-git-and-prs-safely
description: Use before merging stacked or squash-merged pull requests, deleting branches, pruning refs, removing worktrees, stashing, or reverting files, and whenever a git or gh command succeeded but the result may be wrong (stacked PR closed, origin/main missing, branch looks unmerged, uncommitted work gone).
---

# Handling git and PRs safely

**REQUIRED BACKGROUND:** `superpowers:finishing-a-development-branch` (merge, PR and cleanup
options) and `superpowers:using-git-worktrees`. Repo rules (CLAUDE.md) win over this skill.

Most git damage is silent: the command exits 0 and the state is wrong. Confirm every outcome
by reading state back, never by the exit code.

| Before you… | Do this | Because |
|---|---|---|
| Merge a parent PR in a stack | Merge without `--delete-branch`; retarget the child (`gh pr edit N --base main`), confirm its `baseRefName`, then delete | Deleting the parent's branch can close the child PR permanently |
| Replay a child after a squash merge | `git rebase --onto origin/main <old-parent-tip> <child>` | The child still carries the parent's pre-squash commits |
| Decide a branch is unmerged | `gh pr list --head <b> --state all`, or grep its content on `origin/main` | Squash-merged branches look unmerged to `git cherry` and `--merged` |
| Prune refs | `git fetch origin --prune`, never together with an explicit `src:dst` refspec | Refspec plus `--prune` can delete `origin/main` |
| Remove a worktree | `git -C <wt> status --porcelain --ignored` first, run from outside it | Plain status hides ignored files such as `.env`; you cannot delete your own cwd |
| Trust a worktree is gone | Check the filesystem, not only `git worktree list` | The list can drop it while files remain |
| Revert one experiment | Commit first; `git checkout -- <file>` drops every uncommitted edit to it | It discards everything, not just the experiment |
| Trust a clean rebase | Re-run tests and re-read functions both sides edited | No conflict is not evidence of correctness |
| Stash | No bare `git stash pop`; use a WIP commit, or a tagged stash applied by SHA | The stash stack is shared across worktrees and sessions |
| Report a merge done | After fetch: `gh pr view N --json state,mergeCommit` and `git log origin/main -3` | Some merge paths print nothing on success |

Commit messages and PR bodies: write them to a file (`git commit -F`, `gh pr create
--body-file`) and read the result back (`git log -1 --format=%B`), so shell quoting cannot
mangle them.

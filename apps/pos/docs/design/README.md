# POS design captures

This folder holds design references and capture evidence for the POS (`pos-v3.5`, `rt-1042`,
`rt-1044`, `vnext`). It already weighs about 116 MB in about 2,900 files, and every clone and CI
checkout pays for it (RT-1460, audit A-19).

## Going-forward storage rule (RT-1460, in effect)

**New captures are not committed to git. Produce them in CI, upload them as a workflow artifact
(or attach them to a release), and link them from the markdown.**

- This is the same rule the Admin Console already follows: its captures are produced by
  `.github/workflows/admin-captures.yml` and uploaded as an artifact (owner decision 2026-11-04,
  RT-1118: captures are made in CI, never on the laptop).
- In the markdown, write the artifact name and the run or release link next to the finding, so the
  evidence stays traceable without living in git.
- Small, hand-authored SVG or a single reference image that a document cannot work without may be
  committed, as long as it stays under the guard's limits below.

Git LFS was considered and **not** chosen: it adds a tool every contributor and agent session must
install, it has a separate storage and bandwidth quota, and a clone without `git-lfs` silently gets
pointer files. No `.gitattributes` LFS rule exists, so no CI checkout needs `lfs: true`.

## The guard

`tools/size-guard/size_guard.py` runs in the always-run `boundary-check` job
(`.github/workflows/project-graph.yml`). It fails a pull request that:

1. leaves a binary (png, jpg, jpeg, gif, webp, avif, mp4, mov, webm, zip, gz, tgz, 7z, pdf) larger
   than 500 KB in the tree unless it is in the grandfather list, or lets a grandfathered file grow;
2. adds or grows more than 2 MiB of binaries in one change (the design folder is made of files
   under 100 KB, so a per-file limit alone would not have stopped it);
3. adds or raises a grandfather entry, or raises either limit.

The grandfather list is `allowlist` in `tools/size-guard/config.json`. It is shrink-only: delete an
entry when you delete or shrink the file (the guard tells you when an entry is stale). Existing
captures stay where they are; nothing is deleted and no history is rewritten. Removing the existing
captures from the working tree, or a history rewrite, are separate decisions for the owner.

The guard is a habit-stopper, not a sandbox: it sees only the listed binary extensions (a renamed
file or an extensionless blob is not seen), and the 2 MiB budget is per change. CI runs the
base branch's copy of the script, so a pull request cannot loosen the guard it is judged by.

Run it locally before pushing:

```bash
python3 tools/size-guard/size_guard.py check --base origin/main
python3 -m unittest discover -s tools/size-guard
```

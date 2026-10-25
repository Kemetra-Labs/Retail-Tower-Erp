# tools/cutover

`repo_settings.py` is the RT-715 settings-as-script (owner decision RT-715 c13785). It copies Shadow's GitHub
repository settings to the canonical repository `Kemetra-Labs/Retail-Tower-Erp`, so they are not redone by hand.

```bash
# 1. read Shadow (read-only); skip Shadow-only canary rulesets
python3 tools/cutover/repo_settings.py export --repo Kemetra/Retail-Tower-Shadow --out snapshot.json \
  --skip-ruleset approval-canary-pr-rules --skip-ruleset r3-canary-required-source-pin
# 2. what would change on the target (read-only)
python3 tools/cutover/repo_settings.py plan --snapshot snapshot.json --target Kemetra-Labs/Retail-Tower-Erp
# 3. cutover step 7 only, with the owner's GO: write, then re-plan and fail on any remaining difference
python3 tools/cutover/repo_settings.py apply --snapshot snapshot.json --target Kemetra-Labs/Retail-Tower-Erp --yes
```

**Covers:** merge settings, secret scanning and push protection, Actions permissions, rulesets (matched by
name), environments with deployment branch/tag policies, wait timer and required reviewers, and the names of
repository and environment secrets and variables.

**Owner actions it lists as TODOs, never does:**

* every secret and variable **value**: the script never reads or prints one;
* the installation of any GitHub App that a required status check references by integration id; that app
  must be installed on the target. The gate needs none: since the owner decision of 2026-10-25,
  `gate.yml` posts `required` with its own `GITHUB_TOKEN` (the `kemetra-ci-gate` App was retired).

**Not covered:**

* Organization settings.
* Team reviewer ids from another organization. The target is in `Kemetra-Labs`, so check team reviewers by
  hand. User reviewer ids are global.
* `policy_approvers`: lives in `tools/project-graph/graph.yaml` and moves with the history.

The snapshot copies Shadow **as it is**. Today Shadow `main` has a pull-request ruleset with an admin-role
bypass and no required `required` check. Per RT-715 c13840, the no-bypass `required` ruleset (RT-866) is
post-cutover hardening; add it to Shadow first if it should be copied.

Tests: `python3 -m unittest tools/cutover/test_repo_settings.py` (pure functions, no network).

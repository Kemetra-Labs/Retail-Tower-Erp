"""RT-927 Task 6: deploy-erp-lab.yml (text checks; privilege invariants are pgraph privileges' job)."""

import re
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "deploy-erp-lab.yml"
DOCKERFILE = REPO_ROOT / "integrations" / "erpnext-connector" / "deploy" / "erp.Dockerfile"
README = REPO_ROOT / "integrations" / "erpnext-connector" / "deploy" / "README.md"


@pytest.fixture(scope="module")
def text() -> str:
    return WORKFLOW.read_text(encoding="utf-8").replace("\r\n", "\n")


def _job(text: str, name: str) -> str:
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [a-z][a-z0-9_-]*:\n|\Z)", text, re.M | re.S)
    assert match, f"job {name} missing"
    return match.group(1)


def test_dispatch_only_main(text):
    head = text.split("jobs:")[0]
    assert re.search(r'^"on":\n  workflow_dispatch:', head, re.M)
    triggers = re.search(r'^"on":\n((?:  .*\n|\n)+)', head, re.M).group(1)
    assert re.findall(r"^  ([a-z_]+):", triggers, re.M) == ["workflow_dispatch"]
    assert '[ "$RUN_REF" = "refs/heads/main" ]' in _job(text, "preflight")
    assert '[ "$RUN_REF" = "refs/heads/main" ]' in _job(text, "live")


def test_permissions_empty_at_the_top(text):
    assert re.search(r"^permissions: \{\}$", text, re.M)


def test_concurrency_shared_with_the_backend_lab_path(text):
    assert re.search(r"^concurrency:\n  group: deploy-aws-lab\n  cancel-in-progress: false$", text, re.M)


def test_environment_only_on_live(text):
    assert text.count("environment: aws-lab") == 1
    assert "environment: aws-lab" in _job(text, "live")
    assert "id-token: write" in _job(text, "live")
    assert "id-token" not in _job(text, "preflight")


def test_live_if_dry_run_false(text):
    live = _job(text, "live")
    assert "needs: preflight" in live
    assert "if: ${{ inputs.dry_run == false }}" in live


def test_dry_run_defaults_true_and_inputs(text):
    head = text.split("jobs:")[0]
    for name in ("target_digest", "target_sha", "current_sha", "current_images", "jira_key", "hold",
                 "save_current_image", "dry_run"):
        assert re.search(rf"^      {name}:$", head, re.M), name
    assert re.search(r"^      dry_run:\n(?:        .*\n)*?        default: true$", head, re.M)


def test_preflight_verifies_attestation(text):
    pre = _job(text, "preflight")
    assert 'gh attestation verify "oci://ghcr.io/kemetra-labs/rt-erpnext@' in pre
    assert "--signer-workflow Kemetra-Labs/Retail-Tower-Erp/.github/workflows/build-erp-image.yml" in pre
    assert "--source-ref refs/heads/main" in pre


def test_preflight_runs_rollback_class_on_full_shas(text):
    pre = _job(text, "preflight")
    assert "deploy/lab/rollback_class.py --repo" in pre
    assert '--current "$CURRENT_SHA" --target "$TARGET_SHA"' in pre
    assert "^[0-9a-f]{40}$" in pre
    assert "merge-base --is-ancestor" in pre


def test_target_labels_are_checked_against_main(text):
    pre = _job(text, "preflight")
    assert "skopeo inspect --config" in pre
    for label in ("org.opencontainers.image.revision", "rt.connector.tree", "rt.base.digest", "rt.connector.version"):
        assert label in pre, label


def test_base_digest_compared_and_equal_to_the_dockerfile(text):
    match = re.search(r"BASE_DIGEST: (sha256:[0-9a-f]{64})", text)
    assert match
    assert f"FROM frappe/erpnext@{match.group(1)}" in DOCKERFILE.read_text(encoding="utf-8")
    assert '"$BASE_DIGEST"' in _job(text, "preflight")


def test_current_images_map_is_validated_in_preflight(text):
    pre = _job(text, "preflight")
    assert "backend frontend websocket scheduler queue-short queue-long" in pre


def test_environment_gate_is_read_back_before_live(text):
    pre = _job(text, "preflight")
    assert "repos/$REPO/environments/aws-lab" in pre
    assert "environment_gate" in pre
    assert '[ "$ENVIRONMENT_GATE" = "reviewed" ]' in _job(text, "live")


def test_node_by_tags_lab03(text):
    live = _job(text, "live")
    assert '"Key=tag:Environment,Values=lab" "Key=tag:Host,Values=lab-03"' in live
    assert "^mi-[0-9a-f]{17}$" in live


def test_only_the_erp_document_is_sent(text):
    live = _job(text, "live")
    assert re.findall(r"--document-name (\S+)", live) == ["RT-ErpLabDeploy"]
    assert "AWS-RunShellScript" not in text
    assert "start-session" not in text


def test_only_strict_rt_lines_reach_the_log(text):
    live = _job(text, "live")
    assert "RESULT_RE='^RT_(" in live
    assert 'grep -E "$RESULT_RE"' in live


def test_fails_closed_without_the_deploy_variables(text):
    live = _job(text, "live")
    assert 'AWS_ROLE_ARN is not set' in live
    assert "role-to-assume: ${{ vars.AWS_ROLE_ARN }}" in live


def test_claims_are_printed_for_this_workflow_file(text):
    assert "--workflow-file deploy-erp-lab.yml" in _job(text, "live")


def test_ledger_uploaded(text):
    assert "name: deploy-erp-lab-plan-${{ github.run_id }}" in _job(text, "preflight")
    live = _job(text, "live")
    assert "name: deploy-erp-lab-live-ledger-${{ github.run_id }}" in live
    assert "if: always()" in live


def test_every_action_is_pinned_by_sha(text):
    uses = re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", text, re.M)
    assert uses
    for ref in uses:
        assert re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", ref), ref


def test_inputs_never_expanded_inside_run_scripts(text):
    for block in re.findall(r"run: \|\n((?:          .*\n|\n)+)", text):
        assert "${{" not in block, block[:200]


def test_readme_covers_the_owner_steps():
    readme = README.read_text(encoding="utf-8")
    for needle in ("Host=lab-03", "create-document", "RT-ErpLabDeploy", "public", "restore.sh",
                   "forward-fix", "build-erp-image.yml", "deploy-erp-lab.yml", "RT_PROBE_B64"):
        assert needle in readme, needle

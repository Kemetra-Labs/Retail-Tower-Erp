"""RT-927 Task 1: the ERP lab image recipe and its build workflow (static checks, stdlib only)."""

import re
from pathlib import Path

DEPLOY = Path(__file__).resolve().parents[1]
CONNECTOR_ROOT = DEPLOY.parent
REPO_ROOT = CONNECTOR_ROOT.parents[1]

BASE_DIGEST = "sha256:f2d409c58ed1b688b6f2914d4a7f8b2468ee60bd1a3f1bd82d6fe32071806cb1"


def _read(path: Path) -> str:
    # The repo index is LF; a Windows checkout may be CRLF. Compare on LF.
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


DOCKERFILE = DEPLOY / "erp.Dockerfile"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "build-erp-image.yml"
CONNECTOR_CI = REPO_ROOT / ".github" / "workflows" / "erpnext-connector.yml"
GRAPH = REPO_ROOT / "tools" / "project-graph" / "graph.yaml"


def _from_lines(text: str) -> list[str]:
    return [line for line in text.splitlines() if line.startswith("FROM ")]


def test_base_pinned_by_digest():
    text = _read(DOCKERFILE)
    assert _from_lines(text)[0] == f"FROM frappe/erpnext@{BASE_DIGEST}"
    assert ":v16" not in text
    assert len(_from_lines(text)) == 1, "a single stage, no second base"


def test_copy_owner_and_target():
    text = _read(DOCKERFILE)
    assert re.search(r"^COPY --chown=1000:0 \S+ apps/retail_tower_erpnext_connector$", text, re.M)


def test_installs_into_the_bench_env_with_a_uv_fallback():
    text = _read(DOCKERFILE)
    assert "./env/bin/pip install --no-cache-dir -e apps/retail_tower_erpnext_connector" in text
    assert "uv pip install --python ./env/bin/python -e apps/retail_tower_erpnext_connector" in text
    assert "print(m.__version__)" in text


def test_labels_declared():
    text = _read(DOCKERFILE)
    for key in (
        "org.opencontainers.image.revision",
        "rt.connector.tree",
        "rt.connector.version",
        "rt.base.digest",
    ):
        assert key in text, key
    assert f'rt.base.digest="{BASE_DIGEST}"' in text


def test_build_workflow_guards():
    text = _read(WORKFLOW)
    assert re.search(r'^"on":\n  workflow_dispatch:', text, re.M), "dispatch is the only trigger"
    assert "pull_request" not in text.replace("pull_request_target", "pull_request")
    assert "push:" not in text.split("jobs:")[0]
    assert "refs/heads/main" in text
    assert re.search(r"^permissions: \{\}$", text, re.M)
    assert re.search(r"actions/attest-build-provenance@[0-9a-f]{40} # v", text)
    assert "push-to-registry: true" in text
    assert "environment:" not in text, "no environment: GHCR is the only write"


def test_every_action_is_pinned_by_sha():
    uses = re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", _read(WORKFLOW), re.M)
    assert uses
    for ref in uses:
        assert re.fullmatch(r"[\w./-]+@[0-9a-f]{40}", ref), ref


def test_workflow_base_digest_equals_the_dockerfile():
    workflow = _read(WORKFLOW)
    assert f"BASE_DIGEST: {BASE_DIGEST}" in workflow
    assert f"frappe/erpnext@{BASE_DIGEST}" in _read(DOCKERFILE)


def test_publish_refuses_to_move_an_existing_tag():
    text = _read(WORKFLOW)
    assert "refusing to overwrite" in text
    assert "skopeo copy --preserve-digests" in text


def test_publish_verifies_labels_after_the_push():
    text = _read(WORKFLOW)
    for key in ("org.opencontainers.image.revision", "rt.connector.tree", "rt.base.digest"):
        assert key in text.split("name: Verify the registry digest and labels")[1], key


def test_workflow_emits_the_image_line():
    text = _read(WORKFLOW)
    assert "RT_IMAGE ghcr.io/kemetra-labs/rt-erpnext@" in text
    assert re.search(r"^\s+digest: \$\{\{ steps\.\w+\.outputs\.digest \}\}", text, re.M)
    assert re.search(r"^\s+tag: \$\{\{ steps\.\w+\.outputs\.tag \}\}", text, re.M)


def test_source_commit_is_an_ancestor_of_main_and_full_sha_only():
    text = _read(WORKFLOW)
    assert "^[0-9a-f]{40}$" in text
    assert "merge-base --is-ancestor" in text


def test_graph_has_a_deploy_tier_that_selects_the_unit_job():
    text = _read(GRAPH)
    match = re.search(r"^      deploy:\n        globs: \[deploy/\*\*\]\n        jobs: \[connector/unit-tests-and-lint\]$", text, re.M)
    assert match, "tier `deploy` under erpnext-connector"


def test_connector_unit_job_runs_the_deploy_tests():
    text = _read(CONNECTOR_CI)
    assert "python -m pytest -q deploy/tests" in text

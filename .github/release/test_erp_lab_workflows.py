"""RT-927: static checks of the two root workflows of the ERP lab deploy path.

build-erp-image.yml and deploy-erp-lab.yml live in the root .github/, and the project graph
forbids a product's tests from reading outside the product. So their checks live here and run
in project-graph-selftest (`python -m unittest discover -s .github/release`). The Connector's own
deploy-path tests stay in integrations/erpnext-connector/deploy/tests.
"""

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
CONNECTOR_DEPLOY = ROOT / "integrations" / "erpnext-connector" / "deploy"
BASE_DIGEST = "sha256:f2d409c58ed1b688b6f2914d4a7f8b2468ee60bd1a3f1bd82d6fe32071806cb1"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def job(text: str, name: str) -> str:
    match = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [a-z][a-z0-9_-]*:\n|\Z)", text, re.M | re.S)
    if not match:
        raise AssertionError(f"job {name} missing")
    return match.group(1)


def triggers(text: str) -> list[str]:
    block = re.search(r'^"on":\n((?:  .*\n|\n)+)', text, re.M).group(1)
    return re.findall(r"^  ([a-z_]+):", block, re.M)


class PinnedActions:
    text = ""

    def test_every_action_is_pinned_by_sha(self):
        uses = re.findall(r"^\s*(?:-\s+)?uses:\s*(\S+)", self.text, re.M)
        self.assertTrue(uses)
        for ref in uses:
            self.assertRegex(ref, r"^[\w./-]+@[0-9a-f]{40}$")

    def test_permissions_empty_at_the_top(self):
        self.assertRegex(self.text, r"(?m)^permissions: \{\}$")

    def test_dispatch_is_the_only_trigger(self):
        self.assertEqual(triggers(self.text), ["workflow_dispatch"])

    def test_inputs_never_expanded_inside_run_scripts(self):
        for block in re.findall(r"run: \|\n((?:          .*\n|\n)+)", self.text):
            self.assertNotIn("${{", block, block[:200])


class BuildErpImage(PinnedActions, unittest.TestCase):
    text = read(WORKFLOWS / "build-erp-image.yml")

    def test_main_only_and_no_environment(self):
        self.assertIn('[ "$DISPATCH_REF" = "refs/heads/main" ]', self.text)
        self.assertNotIn("environment:", self.text)

    def test_attestation_pushed_to_the_registry(self):
        self.assertRegex(self.text, r"actions/attest-build-provenance@[0-9a-f]{40} # v")
        self.assertIn("push-to-registry: true", self.text)

    def test_base_digest_equals_the_dockerfile(self):
        self.assertIn(f"BASE_DIGEST: {BASE_DIGEST}", self.text)
        self.assertIn(f"FROM frappe/erpnext@{BASE_DIGEST}", read(CONNECTOR_DEPLOY / "erp.Dockerfile"))

    def test_publish_refuses_to_move_an_existing_tag(self):
        self.assertIn("refusing to overwrite", self.text)
        self.assertIn("skopeo copy --preserve-digests", self.text)

    def test_publish_verifies_labels_after_the_push(self):
        verify = self.text.split("name: Verify the registry digest and labels")[1]
        for key in ("org.opencontainers.image.revision", "rt.connector.tree", "rt.base.digest"):
            self.assertIn(key, verify)

    def test_emits_the_image_line_and_outputs(self):
        self.assertIn("RT_IMAGE ghcr.io/kemetra-labs/rt-erpnext@", self.text)
        self.assertRegex(self.text, r"(?m)^\s+digest: \$\{\{ steps\.\w+\.outputs\.digest \}\}")
        self.assertRegex(self.text, r"(?m)^\s+tag: \$\{\{ steps\.\w+\.outputs\.tag \}\}")

    def test_source_commit_is_a_full_sha_on_main(self):
        self.assertIn("^[0-9a-f]{40}$", self.text)
        self.assertIn("merge-base --is-ancestor", self.text)


class DeployErpLab(PinnedActions, unittest.TestCase):
    text = read(WORKFLOWS / "deploy-erp-lab.yml")

    def test_main_only_in_both_jobs(self):
        self.assertIn('[ "$RUN_REF" = "refs/heads/main" ]', job(self.text, "preflight"))
        self.assertIn('[ "$RUN_REF" = "refs/heads/main" ]', job(self.text, "live"))

    def test_concurrency_shared_with_the_backend_lab_path(self):
        self.assertRegex(self.text, r"(?m)^concurrency:\n  group: deploy-aws-lab\n  cancel-in-progress: false$")
        self.assertIn("group: deploy-aws-lab", read(WORKFLOWS / "deploy-lab.yml"))

    def test_environment_and_id_token_only_on_live(self):
        self.assertEqual(self.text.count("environment: aws-lab"), 1)
        live, pre = job(self.text, "live"), job(self.text, "preflight")
        self.assertIn("environment: aws-lab", live)
        self.assertIn("id-token: write", live)
        self.assertNotIn("id-token", pre)

    def test_live_only_after_preflight_and_never_on_a_dry_run(self):
        live = job(self.text, "live")
        self.assertIn("needs: preflight", live)
        self.assertIn("if: ${{ inputs.dry_run == false }}", live)

    def test_inputs_and_dry_run_default(self):
        head = self.text.split("jobs:")[0]
        for name in ("target_digest", "target_sha", "current_sha", "current_images", "jira_key", "hold",
                     "save_current_image", "dry_run"):
            self.assertRegex(head, rf"(?m)^      {name}:$")
        self.assertRegex(head, r"(?m)^      dry_run:\n(?:        .*\n)*?        default: true$")

    def test_preflight_verifies_the_attestation_from_main(self):
        pre = job(self.text, "preflight")
        self.assertIn('gh attestation verify "oci://ghcr.io/kemetra-labs/rt-erpnext@', pre)
        self.assertIn("--signer-workflow Kemetra-Labs/Retail-Tower-Erp/.github/workflows/build-erp-image.yml", pre)
        self.assertIn("--source-ref refs/heads/main", pre)

    def test_preflight_runs_the_rollback_class_on_full_shas(self):
        pre = job(self.text, "preflight")
        self.assertIn("deploy/lab/rollback_class.py --repo", pre)
        self.assertIn('--current "$CURRENT_SHA" --target "$TARGET_SHA"', pre)
        self.assertIn("^[0-9a-f]{40}$", pre)
        self.assertIn("merge-base --is-ancestor", pre)
        self.assertTrue((CONNECTOR_DEPLOY / "lab" / "rollback_class.py").is_file())

    def test_target_labels_are_checked_against_main(self):
        pre = job(self.text, "preflight")
        self.assertIn("skopeo inspect --config", pre)
        for label in ("org.opencontainers.image.revision", "rt.connector.tree", "rt.base.digest", "rt.connector.version"):
            self.assertIn(label, pre)

    def test_base_digest_compared_and_equal_to_the_dockerfile(self):
        self.assertIn(f"BASE_DIGEST: {BASE_DIGEST}", self.text)
        self.assertIn('"$BASE_DIGEST"', job(self.text, "preflight"))

    def test_current_images_map_is_validated(self):
        pre = job(self.text, "preflight")
        self.assertIn("backend frontend websocket scheduler queue-short queue-long", pre)
        # The SSM parameter pattern caps the map at 1002 characters (RE2 refuses a repeat above 1000).
        self.assertIn('[ "${#CURRENT_IMAGES}" -le 1002 ]', pre)

    def test_environment_gate_is_read_back_before_live(self):
        pre = job(self.text, "preflight")
        self.assertIn("repos/$REPO/environments/aws-lab", pre)
        self.assertIn("environment_gate", pre)
        self.assertIn('[ "$ENVIRONMENT_GATE" = "reviewed" ]', job(self.text, "live"))

    def test_node_by_tags_lab03(self):
        live = job(self.text, "live")
        self.assertIn('"Key=tag:Environment,Values=lab" "Key=tag:Host,Values=lab-03"', live)
        self.assertIn("^mi-[0-9a-f]{17}$", live)

    def test_only_the_erp_document_is_sent(self):
        live = job(self.text, "live")
        self.assertEqual(re.findall(r"--document-name (\S+)", live), ["RT-ErpLabDeploy"])
        self.assertNotIn("AWS-RunShellScript", self.text)
        self.assertNotIn("start-session", self.text)
        params = set(re.findall(r"\b([A-Z][A-Za-z]+): \[\$", live))
        document = read(CONNECTOR_DEPLOY / "lab" / "ssm" / "RT-ErpLabDeploy.json")
        for name in params:
            self.assertIn(f'"{name}"', document, f"{name} is not a document parameter")

    def test_only_strict_rt_lines_reach_the_log(self):
        live = job(self.text, "live")
        self.assertIn("RESULT_RE='^RT_(", live)
        self.assertIn('grep -E "$RESULT_RE"', live)

    def test_fails_closed_without_the_deploy_variables(self):
        live = job(self.text, "live")
        self.assertIn("AWS_ROLE_ARN is not set", live)
        self.assertIn("role-to-assume: ${{ vars.AWS_ROLE_ARN }}", live)

    def test_claims_are_printed_for_this_workflow_file(self):
        self.assertIn("--workflow-file deploy-erp-lab.yml", job(self.text, "live"))

    def test_ledgers_uploaded(self):
        self.assertIn("name: deploy-erp-lab-plan-${{ github.run_id }}", job(self.text, "preflight"))
        live = job(self.text, "live")
        self.assertIn("name: deploy-erp-lab-live-ledger-${{ github.run_id }}", live)
        self.assertIn("if: always()", live)


class ConnectorGraphAndCi(unittest.TestCase):
    def test_graph_has_a_deploy_tier_that_selects_the_unit_job(self):
        self.assertRegex(read(ROOT / "tools" / "project-graph" / "graph.yaml"),
                         r"(?m)^      deploy:\n        globs: \[deploy/\*\*\]\n        jobs: \[connector/unit-tests-and-lint\]$")

    def test_connector_unit_job_runs_and_lints_the_deploy_tests(self):
        text = read(WORKFLOWS / "erpnext-connector.yml")
        self.assertIn("python -m pytest -q deploy/tests", text)
        self.assertIn("python -m ruff check retail_tower_erpnext_connector deploy", text)

    def test_readme_covers_the_owner_steps(self):
        readme = read(CONNECTOR_DEPLOY / "README.md")
        for needle in ("Host=lab-03", "create-document", "RT-ErpLabDeploy", "public", "restore.sh",
                       "forward-fix", "build-erp-image.yml", "deploy-erp-lab.yml", "RT_PROBE_B64"):
            self.assertIn(needle, readme)


if __name__ == "__main__":
    unittest.main()

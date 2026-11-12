"""RT-1363: the withdraw mode of promote-pos-pilot.yml.

Backend-Core takes a withdrawal (`POST /api/v1/platform/pos-pilot-releases/{releaseId}/withdraw`, RT-1298) only
from the promotion workflow's GitHub OIDC token, and the `job_workflow_ref` pin names promote-pos-pilot.yml
itself, so the withdraw jobs live in that file. What this proves, offline, on the workflow text and by running
the two step scripts under bash with `curl` stubbed:

  - the mode input gates the jobs: in withdraw mode no promote job runs, in promote mode no withdraw job runs,
    and an unexpected mode runs nothing;
  - the dry run (the default) holds no environment, no id-token and no credential, and says what it would do;
  - the live job holds the protected environment and an id-token and nothing else, runs from main only, and is
    started by a person (a GitHub login, never an app);
  - every input is validated before anything is requested; the answer must be the requested release, now
    withdrawn; any other answer is refused with its code;
  - nothing here touches S3, IAM or the register path, and nothing activates a release.

No test sends a request: `curl` is a shell function that logs its arguments.
"""
import json
import re
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_console_lab_workflow import HAVE_BASH, ROOT, WORKFLOWS, job, read, step_script  # noqa: E402
from test_pos_pilot_release_workflow import code  # noqa: E402
from test_pos_release_workflow import needs_of, step  # noqa: E402
from test_promote_pos_pilot_workflow import (  # noqa: E402
    API, AUDIENCE, ENVIRONMENT, NEVER_IN_THE_VERIFY_JOBS, RUNBOOK, STUB_CURL, run_bash, runner_temp,
)

WORKFLOW = WORKFLOWS / "promote-pos-pilot.yml"
CHECK = "withdraw-check"
LIVE = "withdraw"
STEP_CHECK = "Check the withdraw request"
STEP_WITHDRAW = "Withdraw the release through Backend-Core (OIDC bearer; it is not re-activated or deleted)"
TAG = "pos-pilot/v0.1.3"
VERSION = "0.1.3"
# A UUID v7, the shape of a registry row id (what `newId()` makes and the route's uuid schema accepts).
RELEASE_ID = "01a1cadf-32d9-722f-adec-1ecc59e1d8dd"
PROMOTE_JOBS = ("resolve", "verify", "upload", "register")
ALL_JOBS = (*PROMOTE_JOBS, CHECK, LIVE)


def job_names(text: str) -> list[str]:
    return re.findall(r"^  ([a-z][a-z0-9-]*):$", text.split("\njobs:\n", 1)[1], re.M)


def holds(expression: str, mode: str, dry_run: bool) -> bool:
    """Evaluates the `if:` expressions this file uses (inputs.mode, inputs.dry_run, ==, &&, !) and nothing else."""
    translated = (expression.replace("&&", " and ").replace("||", " or ").replace("!inputs.dry_run", " (not DRY) ")
                  .replace("inputs.dry_run", " DRY ").replace("inputs.mode", " MODE "))
    if not re.fullmatch(r"[\sA-Z'a-z()=]+", translated):
        raise AssertionError(f"an expression this test does not model: {expression}")
    return bool(eval(translated, {"__builtins__": {}}, {"MODE": mode, "DRY": dry_run}))  # noqa: S307 (the workflow text of this repo)


def jobs_that_run(text: str, mode: str, dry_run: bool) -> set[str]:
    """What GitHub would start: a job runs when its `if` holds (no `if` holds) and every job it needs ran."""
    ran: set[str] = set()
    for name in job_names(text):
        block = job(text, name)
        condition = re.search(r"^    if: \$\{\{ (.*) \}\}$", block, re.M)
        if (condition is None or holds(condition.group(1), mode, dry_run)) and all(need in ran for need in needs_of(block)):
            ran.add(name)
    return ran


def withdraw_env(tmp: Path, **extra: str) -> dict:
    """What a withdraw step sees: the job's env, the environment's variables and the fakes' log files."""
    env = {"REF": "refs/heads/main", "ACTOR": "octocat", "TAG": TAG, "RELEASE_ID": RELEASE_ID, "DRY_RUN": "true",
           "API_BASE": API, "AUDIENCE": AUDIENCE, "RUNNER_TEMP": runner_temp(tmp),
           "GITHUB_STEP_SUMMARY": str(tmp / "summary.md"), "CURL_LOG": str(tmp / "curl.log"), "CURL_STDIN": str(tmp / "curl.stdin"),
           "ACTIONS_ID_TOKEN_REQUEST_URL": "https://token.example.net/oidc?api-version=2", "ACTIONS_ID_TOKEN_REQUEST_TOKEN": "requesttoken",
           "FAKE_RESP": json.dumps(withdrawn_release()), "FAKE_HTTP": "200"}
    env.update(extra)
    return env


def withdrawn_release(**changes) -> dict:
    """What the route answers for a release that is now withdrawn; each keyword replaces one field."""
    base = {"releaseId": RELEASE_ID, "version": VERSION, "approved": False, "signingClass": "pilot",
            "withdrawnAt": "2026-11-12T20:00:00.000Z", "withdrawnBy": "octocat"}
    base.update(changes)
    return base


class PromotePosPilotWithdrawStatic(unittest.TestCase):
    text = read(WORKFLOW)

    def test_the_inputs_are_a_mode_the_tag_the_pin_a_release_id_and_dry_run(self):
        block = re.search(r"workflow_dispatch:\n    inputs:\n((?:      .*\n|        .*\n)+)", self.text).group(1)

        def one(name: str) -> str:
            return re.search(rf"^      {name}:\n((?:        .*\n)+)", block, re.M).group(1)

        mode = one("mode")
        self.assertIn("type: choice", mode)
        self.assertEqual(re.findall(r"^          - (\S+)$", mode, re.M), ["promote", "withdraw"])
        self.assertIn("default: promote", mode, "an old dispatch that names no mode stays a promotion")
        self.assertIn("required: true", one("tag"), "withdraw names the version too, so the approver sees both")
        # The pin is a promote-only input: withdraw must not ask for a thumbprint it never uses (resolve refuses an empty one).
        self.assertIn("required: false", one("leaf_sha1"))
        release = one("release_id")
        self.assertIn("type: string", release)
        self.assertIn("required: false", release)
        self.assertIn("default: true", one("dry_run"))
        self.assertIn("type: boolean", one("dry_run"))

    def test_an_empty_pin_still_refuses_a_promotion_because_resolve_checks_it_itself(self):
        script = step_script(job(self.text, "resolve"), "Resolve the tag and the leaf pin")
        self.assertIn('[[ "$LEAF_SHA1" =~ ^[0-9A-Fa-f]{40}$ ]] || fail', script)

    def test_the_mode_decides_which_jobs_run_and_an_unexpected_mode_runs_nothing(self):
        text = self.text
        self.assertEqual(job_names(text), list(ALL_JOBS))
        self.assertEqual(jobs_that_run(text, "promote", True), {"resolve", "verify"})
        self.assertEqual(jobs_that_run(text, "promote", False), set(PROMOTE_JOBS))
        self.assertEqual(jobs_that_run(text, "withdraw", True), {CHECK})
        self.assertEqual(jobs_that_run(text, "withdraw", False), {CHECK, LIVE})
        for odd in ("", "Withdraw", "withdraw ", "promote,withdraw", "delete"):
            for dry_run in (True, False):
                self.assertEqual(jobs_that_run(text, odd, dry_run), set(), f"mode {odd!r} dry_run {dry_run}")

    def test_every_job_names_its_mode_in_its_own_condition_and_does_not_lean_on_a_skipped_dependency(self):
        for name in ("resolve", "verify"):
            self.assertIn("if: ${{ inputs.mode == 'promote' }}", job(self.text, name), name)
        for name in ("upload", "register"):
            self.assertIn("if: ${{ inputs.mode == 'promote' && !inputs.dry_run }}", job(self.text, name), name)
        self.assertIn("if: ${{ inputs.mode == 'withdraw' }}", job(self.text, CHECK))
        self.assertIn("if: ${{ inputs.mode == 'withdraw' && !inputs.dry_run }}", job(self.text, LIVE))
        for name in ALL_JOBS:
            self.assertNotIn("!=", re.search(r"^    if: .*$", job(self.text, name), re.M).group(0), name)

    def test_the_live_withdraw_waits_for_the_check_and_the_promote_jobs_never_wait_for_a_withdraw_job(self):
        self.assertEqual(needs_of(job(self.text, LIVE)), [CHECK])
        self.assertEqual(needs_of(job(self.text, CHECK)), [])
        for name in PROMOTE_JOBS:
            for other in (CHECK, LIVE):
                self.assertNotIn(other, " ".join(needs_of(job(self.text, name))), name)

    def test_the_dry_run_job_holds_no_environment_no_token_no_credential_and_no_way_to_publish(self):
        block = job(self.text, CHECK)
        body = code(block)
        for word in NEVER_IN_THE_VERIFY_JOBS:
            self.assertNotIn(word, body, word)
        self.assertNotRegex(body, r"^    environment:", "a dry run asks nobody for an approval")
        self.assertRegex(body, r"(?m)^    permissions: \{\}$", "no token scope at all: it reads nothing and writes nothing")
        self.assertNotIn("uses:", body, "it runs no action and checks nothing out")
        self.assertNotIn("curl", body)
        self.assertNotIn("vars.", body, "the Backend-Core settings are read by the live job only")
        self.assertNotIn("inputs.dry_run", body.replace("DRY_RUN: ${{ inputs.dry_run }}", ""), "the job runs in a dry run and a live run, and reads the flag only through DRY_RUN")

    def test_the_live_job_holds_the_environment_and_an_id_token_only(self):
        body = code(job(self.text, LIVE))
        self.assertEqual(re.findall(r"^    environment: (\S+)$", body, re.M), [ENVIRONMENT])
        block = re.search(r"^    permissions:\n((?:      .*\n)+)", job(self.text, LIVE) + "\n", re.M).group(1)
        self.assertEqual([re.sub(r"\s+#.*$", "", line.strip()) for line in block.splitlines()], ["id-token: write"])
        self.assertNotIn("uses:", body, "no action, no checkout: the job runs no repository code")
        self.assertEqual(sorted(set(re.findall(r"vars\.([A-Z0-9_]+)", body))), ["POS_PILOT_API_BASE_URL", "POS_PILOT_PROMOTION_OIDC_AUDIENCE"])
        self.assertNotIn("secrets.", body)

    def test_the_withdraw_jobs_never_touch_the_bucket_iam_the_register_path_or_an_activation(self):
        for name in (CHECK, LIVE):
            body = code(job(self.text, name))
            for pattern in (r"\baws\b", r"\bs3\b", r"\biam\b", r"configure-aws-credentials", r"put-object",
                            r"delete-object", r"\bgh\b", r"actions/checkout", r"Idempotency-Key", r"/activate", r"-X (?:PUT|DELETE|PATCH)",
                            r"pos-pilot-releases\"", r"--data-binary", r"\$BODY"):
                self.assertNotRegex(body, re.compile(pattern, re.I), f"{name}: {pattern}")
        for name in PROMOTE_JOBS:
            self.assertNotIn("/withdraw", code(job(self.text, name)), name)
        # Exactly one request to the withdraw route, and no other call of the file reaches it.
        self.assertEqual(len(re.findall(r"/withdraw", code(self.text))), 1)
        live = code(job(self.text, LIVE))
        self.assertEqual(live.count("-X POST"), 1)
        self.assertEqual(live.count("curl -K -"), 2, "the id-token request and the withdraw call both read their header from stdin")

    def test_no_credential_reaches_a_process_argument_list_and_the_token_is_masked(self):
        live = code(job(self.text, LIVE))
        self.assertNotIn('-H "Authorization', live)
        self.assertIn("::add-mask::", live)
        self.assertLess(live.index("::add-mask::"), live.index("-X POST"), "masked before it is used")
        for call in re.findall(r"curl [^\n]*", live):
            if "-K -" in call:
                self.assertIn("--proto '=https'", call)
                self.assertIn("--tlsv1.2", call)
        self.assertNotIn(" -L", live)
        self.assertNotIn("--location", live)
        self.assertNotIn("--insecure", live)
        self.assertNotRegex(live, r"curl [^\n]*\s-k\s")

    def test_inputs_reach_the_scripts_only_through_env(self):
        for name in (CHECK, LIVE):
            for block in re.findall(r"run: \|\n((?:          .*\n|\n)+)", job(self.text, name)):
                self.assertNotIn("${{", block, name)

    def test_both_jobs_check_main_the_actor_the_tag_and_the_release_id_before_they_do_anything_else(self):
        for name, step_name in ((CHECK, STEP_CHECK), (LIVE, STEP_WITHDRAW)):
            script = step_script(job(self.text, name), step_name)
            for part in ('[ "$REF" = refs/heads/main ]', '[[ "$ACTOR" =~ ^[A-Za-z0-9](-?[A-Za-z0-9])*$ ]] && [ "${#ACTOR}" -le 39 ]',
                         '[[ "$TAG" =~ ^pos-pilot/v[0-9]+\\.[0-9]+\\.[0-9]+$ ]]', "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}"):
                self.assertIn(part, script, f"{name}: {part}")
            self.assertLess(script.index('[ "$REF" = refs/heads/main ]'), script.index('"$ACTOR"'))
        live = step_script(job(self.text, LIVE), STEP_WITHDRAW)
        self.assertLess(live.index("RELEASE_ID"), live.index("curl"), "every input is validated before the first request")
        self.assertLess(live.index('"$API_BASE" =~'), live.index("curl"))

    def test_one_run_per_tag_so_a_promotion_and_a_withdrawal_of_the_same_version_never_overlap(self):
        self.assertRegex(self.text, r"(?m)^concurrency:\n  group: promote-pos-pilot-\$\{\{ inputs\.tag \}\}\n  cancel-in-progress: false$")

    def test_the_file_header_says_what_withdraw_does_and_what_it_never_does(self):
        header = self.text.split("\nname: promote-pos-pilot", 1)[0]
        for part in ("withdraw", "RT-1363", "never activates", "no object is deleted"):
            self.assertIn(part, header, part)

    def test_the_runbook_documents_the_withdraw_mode_the_inputs_the_approval_and_where_to_find_the_id(self):
        doc = read(RUNBOOK)
        self.assertNotIn("withdrawing is not part of this workflow yet", doc)
        # The runbook wraps its lines: compare on words.
        section7 = " ".join(doc.split("## 7. ", 1)[1].split("## 8. ", 1)[0].split())
        section9 = " ".join(doc.split("## 9. ", 1)[1].split())
        self.assertIn("`mode` = `withdraw`", section7)
        self.assertIn("section 9", section7)
        for part in ("`mode`", "`withdraw`", "`release_id`", "`tag`", "`dry_run`", ENVIRONMENT, "refs/heads/main", "Re-run failed jobs",
                     "never deletes", "register the replacement first", "Console", "not_found", "404", "403", "401"):
            self.assertIn(part, section9, part)


@unittest.skipUnless(HAVE_BASH and shutil.which("jq"), "bash and jq are needed")
class PromotePosPilotWithdrawChecks(unittest.TestCase):
    text = read(WORKFLOW)

    def check(self, tmp: Path, **extra: str):
        return run_bash(step_script(job(self.text, CHECK), STEP_CHECK), withdraw_env(tmp, **extra))

    def test_a_dry_run_validates_and_says_what_it_would_withdraw_and_that_nothing_was(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            result = self.check(temp)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            summary = (temp / "summary.md").read_text(encoding="utf-8")
            for part in (RELEASE_ID, TAG, "dry run", "nothing was withdrawn"):
                self.assertIn(part, summary)
            self.assertFalse((temp / "curl.log").exists(), "a dry run sends nothing")

    def test_a_live_run_tells_the_approver_which_release_and_version_to_confirm_before_approving(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            result = self.check(temp, DRY_RUN="false")
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            summary = (temp / "summary.md").read_text(encoding="utf-8")
            for part in (RELEASE_ID, TAG, "approval", "Console"):
                self.assertIn(part, summary)
            self.assertNotIn("nothing was withdrawn", summary)
            self.assertFalse((temp / "curl.log").exists())

    def test_an_upper_case_release_id_is_accepted_and_shown_in_lower_case(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            result = self.check(temp, RELEASE_ID=RELEASE_ID.upper())
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            summary = (temp / "summary.md").read_text(encoding="utf-8")
            self.assertIn(RELEASE_ID, summary)
            self.assertNotIn(RELEASE_ID.upper(), summary)

    def test_it_refuses_a_run_that_is_not_on_main_or_not_started_by_a_person_or_has_a_bad_tag_or_release_id(self):
        refused = {
            "a branch": {"REF": "refs/heads/rt-1363"},
            "a tag ref": {"REF": "refs/tags/pos-pilot/v0.1.3"},
            "a pull request ref": {"REF": "refs/pull/1/merge"},
            "no ref": {"REF": ""},
            "a bot": {"ACTOR": "dependabot[bot]"},
            "an app": {"ACTOR": "github-actions[bot]"},
            "an underscore login": {"ACTOR": "octo_cat"},
            "a trailing hyphen": {"ACTOR": "octocat-"},
            "a double hyphen": {"ACTOR": "octo--cat"},
            "forty characters": {"ACTOR": "a" * 40},
            "no actor": {"ACTOR": ""},
            "a lab tag": {"TAG": "pos/v0.1.3"},
            "a short version": {"TAG": "pos-pilot/v0.1"},
            "a suffixed tag": {"TAG": "pos-pilot/v0.1.3-rc1"},
            "a look-alike tag": {"TAG": "xpos-pilot/v0.1.3"},
            "a trailing newline tag": {"TAG": "pos-pilot/v0.1.3\nx"},
            "no tag": {"TAG": ""},
            "no release id": {"RELEASE_ID": ""},
            "a word": {"RELEASE_ID": "latest"},
            "the version instead of the id": {"RELEASE_ID": "0.1.3"},
            "a path": {"RELEASE_ID": f"{RELEASE_ID}/../activate"},
            "a query": {"RELEASE_ID": f"{RELEASE_ID}?x=1"},
            "two ids": {"RELEASE_ID": f"{RELEASE_ID} {RELEASE_ID}"},
            "the nil id": {"RELEASE_ID": "00000000-0000-0000-0000-000000000000"},
            "a version 0 id": {"RELEASE_ID": "01a1cadf-32d9-022f-adec-1ecc59e1d8dd"},
            "a bad variant": {"RELEASE_ID": "01a1cadf-32d9-722f-cdec-1ecc59e1d8dd"},
            "a short id": {"RELEASE_ID": RELEASE_ID[:-1]},
            "a long id": {"RELEASE_ID": RELEASE_ID + "0"},
            "a non-hex id": {"RELEASE_ID": RELEASE_ID[:-1] + "g"},
            "a newline in the id": {"RELEASE_ID": RELEASE_ID + "\nx"},
        }
        for label, change in refused.items():
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = self.check(temp, **change)
                self.assertNotEqual(result.returncode, 0, label)
                self.assertIn("::error::", result.stdout + result.stderr, label)
                self.assertFalse((temp / "summary.md").exists(), f"{label}: nothing is announced for a refused request")


@unittest.skipUnless(HAVE_BASH and shutil.which("jq"), "bash and jq are needed")
class PromotePosPilotWithdrawSteps(unittest.TestCase):
    text = read(WORKFLOW)

    def withdraw(self, tmp: Path, **extra: str):
        return run_bash(step_script(job(self.text, LIVE), STEP_WITHDRAW), withdraw_env(tmp, DRY_RUN="false", **extra), preamble=STUB_CURL)

    def test_it_posts_once_to_the_withdraw_route_with_an_oidc_bearer_and_accepts_the_withdrawn_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            result = self.withdraw(temp)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            log = (temp / "curl.log").read_text(encoding="utf-8")
            calls = log.splitlines()
            self.assertEqual(len(calls), 2, "one token request and one withdraw call")
            self.assertIn(f"--data-urlencode audience={AUDIENCE}", calls[0])
            self.assertIn("--get", calls[0])
            self.assertIn(f"-X POST --data  {API}/api/v1/platform/pos-pilot-releases/{RELEASE_ID}/withdraw", calls[1])
            self.assertTrue(calls[1].endswith(f"/{RELEASE_ID}/withdraw"))
            for call in calls:
                self.assertIn("--proto =https", call)
                self.assertNotIn("Idempotency-Key", call, "the route takes no key and no body")
            for secret in ("requesttoken", "jwt.test.token"):
                self.assertNotIn(secret, log, "a credential must never be in an argument list")
            self.assertIn("Authorization: Bearer jwt.test.token", (temp / "curl.stdin").read_text(encoding="utf-8"))
            self.assertIn("::add-mask::jwt.test.token", result.stdout)
            summary = (temp / "summary.md").read_text(encoding="utf-8")
            for part in (RELEASE_ID, TAG, "octocat", "2026-11-12T20:00:00.000Z", "stops offering", "not re-activated", "Console"):
                self.assertIn(part, summary)

    def test_a_release_that_was_already_withdrawn_is_accepted_and_names_who_withdrew_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            earlier = json.dumps(withdrawn_release(withdrawnBy="someone-else", withdrawnAt="2026-11-01T08:00:00.000Z"))
            result = self.withdraw(temp, FAKE_RESP=earlier)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            summary = (temp / "summary.md").read_text(encoding="utf-8")
            self.assertIn("someone-else", summary)
            self.assertIn("2026-11-01T08:00:00.000Z", summary)

    def test_it_refuses_every_answer_but_a_200_and_prints_the_code_the_api_gave(self):
        for status, body, expected in (
            ("400", {"error": {"code": "validation_failed", "message": "x", "request_id": "r"}}, "validation_failed"),
            ("401", {"error": {"code": "unauthorized"}}, "unauthorized"),
            ("403", {"error": {"code": "forbidden"}}, "forbidden"),
            ("404", {"error": {"code": "not_found", "message": "Not found."}}, "not_found"),
            ("409", {"error": {"code": "release_conflict"}}, "release_conflict"),
            ("422", {"error": {"code": "release_not_pilot"}}, "release_not_pilot"),
            ("429", {"error": {"code": "too_many_requests"}}, "too_many_requests"),
            ("500", {"error": {"code": "system_failure"}}, "system_failure"),
            ("500", {"code": "flat_code"}, "flat_code"),
            ("201", withdrawn_release(), "201"),
            ("204", {}, "204"),
            ("302", {}, "302"),
        ):
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = self.withdraw(temp, FAKE_HTTP=status, FAKE_RESP=json.dumps(body))
                self.assertNotEqual(result.returncode, 0, status)
                self.assertIn(expected, result.stdout + result.stderr, status)
                self.assertFalse((temp / "summary.md").exists(), f"{status}: nothing is reported as withdrawn")

    def test_the_code_it_prints_is_plain_text_even_when_the_body_is_not_json_or_carries_markup(self):
        for label, raw in (("html", "<html>oops ::error::injected</html>"), ("empty", ""), ("a string error", '{"error":"boom"}'),
                           ("an array", "[1,2]"), ("a long code", json.dumps({"error": {"code": "x" * 500}})),
                           ("a hostile code", json.dumps({"error": {"code": "a\n::error::forged $(id)"}}))):
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = self.withdraw(temp, FAKE_HTTP="500", FAKE_RESP=raw)
                self.assertNotEqual(result.returncode, 0, label)
                out = result.stdout + result.stderr
                self.assertEqual(out.count("::error::"), 1, f"{label}: one error line, none forged by the body")
                self.assertNotIn("<html>", out, label)
                self.assertLess(len(out), 800, label)

    def test_it_refuses_a_200_that_is_not_the_requested_release_now_withdrawn(self):
        wrong = {
            "another release": {"releaseId": "01a1cadf-32d9-722f-adec-000000000000"},
            "no release id": {"releaseId": None},
            "still approved": {"approved": True},
            "no approved flag": {"approved": None},
            "no withdrawal time": {"withdrawnAt": None},
            "a numeric withdrawal time": {"withdrawnAt": 1},
        }
        for label, change in wrong.items():
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = self.withdraw(temp, FAKE_RESP=json.dumps(withdrawn_release(**change)))
                self.assertNotEqual(result.returncode, 0, label)
                self.assertFalse((temp / "summary.md").exists(), label)
        for body in ("{}", "[]", "null", "not json", ""):
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                self.assertNotEqual(self.withdraw(temp, FAKE_RESP=body).returncode, 0, repr(body))

    def test_a_withdrawal_of_another_version_than_the_run_named_fails_loudly_and_says_it_cannot_be_undone(self):
        with tempfile.TemporaryDirectory() as tmp:
            temp = Path(tmp)
            result = self.withdraw(temp, FAKE_RESP=json.dumps(withdrawn_release(version="0.1.4")))
            self.assertNotEqual(result.returncode, 0)
            out = result.stdout + result.stderr
            for part in (RELEASE_ID, "0.1.4", VERSION, "for good"):
                self.assertIn(part, out)
            self.assertFalse((temp / "summary.md").exists())
            result = self.withdraw(temp, FAKE_RESP=json.dumps(withdrawn_release(version=None)))
            self.assertNotEqual(result.returncode, 0, "an answer without a version is not the release that was named")

    def test_it_asks_for_nothing_when_a_setting_or_an_input_is_wrong(self):
        bad = {
            "a branch": {"REF": "refs/heads/rt-1363"},
            "a bot": {"ACTOR": "dependabot[bot]"},
            "no actor": {"ACTOR": ""},
            "a bad tag": {"TAG": "pos/v0.1.3"},
            "a bad id": {"RELEASE_ID": f"{RELEASE_ID}/activate"},
            "no id": {"RELEASE_ID": ""},
            "a plain http api": {"API_BASE": "http://lab.example.com"},
            "an api with a path": {"API_BASE": "https://lab.example.com/api"},
            "an api with a trailing slash": {"API_BASE": "https://lab.example.com/"},
            "no api": {"API_BASE": ""},
            "the AWS audience": {"AUDIENCE": "sts.amazonaws.com"},
            "no audience": {"AUDIENCE": ""},
            "no id-token request url": {"ACTIONS_ID_TOKEN_REQUEST_URL": ""},
            "no id-token request token": {"ACTIONS_ID_TOKEN_REQUEST_TOKEN": ""},
        }
        for label, change in bad.items():
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = self.withdraw(temp, **change)
                self.assertNotEqual(result.returncode, 0, label)
                self.assertFalse((temp / "curl.log").exists(), f"{label}: nothing is requested, so no token is issued or sent")

    def test_it_sends_no_withdrawal_when_github_issues_no_token(self):
        for label, reply in (("an empty token", '{"value":""}'), ("no token field", "{}")):
            with tempfile.TemporaryDirectory() as tmp:
                temp = Path(tmp)
                result = run_bash(step_script(job(self.text, LIVE), STEP_WITHDRAW),
                                  withdraw_env(temp, DRY_RUN="false", FAKE_TOKEN_REPLY=reply), preamble=STUB_CURL)
                self.assertNotEqual(result.returncode, 0, label)
                self.assertNotIn("/withdraw", (temp / "curl.log").read_text(encoding="utf-8"), f"{label}: the route is never called")


if __name__ == "__main__":
    unittest.main()

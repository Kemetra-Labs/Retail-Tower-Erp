"""RT-1089: tests of draft_manifest.py, the drafting helper for the next system release manifest.

The choices (which release is the latest, which ERP image, which file name) are pure functions,
tested with fake sources. The adapters are tested for their failure paths: a failing gh or git, a
registry answer that is paged or does not match its digest, a gate refusal. The happy path against
the real GitHub, registry and git is the AC2 run (lab-2026.11.2.json reproduced byte for byte).
"""
import contextlib
import datetime
import hashlib
import io
import json
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

import draft_manifest

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIVE = ROOT / "system" / "releases" / "lab-2026.11.2.json"
D1, D2, D3, D4 = ("sha256:" + c * 64 for c in "1234")
S1, S2, S3 = ("a" * 40, "b" * 40, "c" * 40)
BASE = "sha256:" + "f" * 64
POS = "9dfd7d977267806a907d4c03a566382570cbd0c9"


def labels(revision, base=BASE, tree=None):
    return {"org.opencontainers.image.revision": revision, "rt.connector.tree": tree or "t" + revision[1:], "rt.base.digest": base}


class FakeReleases:
    def __init__(self, releases):
        self.releases = releases

    def states(self):
        return self.releases


class FakeImages:
    def __init__(self, tags, labels, attested=()):
        self.tag_map, self.label_map, self.attested = tags, labels, set(attested)
        self.checked = []

    def tags(self):
        return list(self.tag_map)

    def digest_of(self, tag):
        return self.tag_map[tag]

    def labels_of(self, digest):
        return self.label_map.get(digest, {})

    def is_attested(self, digest):
        self.checked.append(digest)
        return digest in self.attested


class FakeGit:
    """Commits on one line of main in `order` (oldest first); `off` are not on main."""

    def __init__(self, order, off=(), branches=None):
        self.order, self.off, self.branches = list(order), set(off), branches or {}

    def is_ancestor(self, older, newer):
        if older in self.branches or newer in self.branches:
            return older == newer
        return self.order.index(older) <= self.order.index(newer)

    def is_on_main(self, sha):
        return sha not in self.off

    def tree_of(self, sha, path):
        return "t" + sha[1:]


def release(draft=False, pre=False, immutable=True):
    return {"isDraft": draft, "isPrerelease": pre, "isImmutable": immutable}


def tag(sha):
    return "16.51.0-" + sha[:12]


class Releases(unittest.TestCase):
    source = FakeReleases({
        "backend-core/v0.3.3": release(), "backend-core/v0.10.0": release(), "backend-core/v0.11.0": release(draft=True),
        "backend-core/v0.12.0": release(pre=True), "backend-core/v0.13.0": release(immutable=False),
        "admin-console/v0.3.0": release(), "pos/v1.0.0": release(),
    })

    def test_latest_is_the_highest_published_immutable_version_not_the_newest_string(self):
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(draft_manifest.pick_release(self.source, "backend-core", "latest"), "backend-core/v0.10.0")
        self.assertEqual(draft_manifest.pick_release(self.source, "admin-console", "latest"), "admin-console/v0.3.0")

    def test_an_explicit_tag_must_be_a_published_immutable_release_of_that_product(self):
        self.assertEqual(draft_manifest.pick_release(self.source, "backend-core", "backend-core/v0.3.3"), "backend-core/v0.3.3")
        for bad in ("backend-core/v0.11.0", "backend-core/v0.12.0", "backend-core/v0.13.0", "backend-core/v9.9.9",
                    "admin-console/v0.3.0", "backend-core/v0.3.3; id"):
            with self.assertRaises(draft_manifest.DraftError, msg=bad):
                draft_manifest.pick_release(self.source, "backend-core", bad)

    def test_no_release_at_all_is_an_error(self):
        with self.assertRaises(draft_manifest.DraftError):
            draft_manifest.pick_release(FakeReleases({}), "backend-core", "latest")


class Erp(unittest.TestCase):
    def pick(self, images, git, wanted="latest"):
        with contextlib.redirect_stderr(io.StringIO()):
            return draft_manifest.pick_erp(images, git, wanted, BASE)

    def test_latest_is_the_attested_image_of_the_newest_commit_on_main(self):
        images = FakeImages({tag(S1): D1, tag(S2): D2, "sha256-" + "1" * 64: D1, "latest": D2},
                            {D1: labels(S1), D2: labels(S2)}, attested=(D1, D2))
        self.assertEqual(self.pick(images, FakeGit([S1, S2])), (D2, S2))

    def test_an_image_off_main_is_skipped_even_when_attested(self):
        images = FakeImages({tag(S1): D1, tag(S2): D2}, {D1: labels(S1), D2: labels(S2)}, attested=(D1, D2))
        self.assertEqual(self.pick(images, FakeGit([S1, S2], off=(S2,))), (D1, S1))
        with self.assertRaises(draft_manifest.DraftError):
            self.pick(images, FakeGit([S1, S2], off=(S2,)), D2)

    def test_an_unattested_newest_image_is_an_error_not_a_fallback(self):
        images = FakeImages({tag(S1): D1, tag(S2): D2}, {D1: labels(S1), D2: labels(S2)}, attested=(D1,))
        with self.assertRaises(draft_manifest.DraftError) as caught:
            self.pick(images, FakeGit([S1, S2]))
        self.assertIn("explicit --erp", str(caught.exception))
        self.assertEqual(images.checked, [D2])  # the older image is never offered in its place
        with self.assertRaises(draft_manifest.DraftError):
            self.pick(images, FakeGit([S1, S2]), D2)
        self.assertEqual(self.pick(images, FakeGit([S1, S2]), D1), (D1, S1))

    def test_an_image_the_preflight_would_refuse_is_skipped(self):
        for bad in (labels(S2, base=D4), labels(S2, tree="x" * 40), labels(S1), {}):
            images = FakeImages({tag(S1): D1, tag(S2): D2}, {D1: labels(S1), D2: bad}, attested=(D1, D2))
            self.assertEqual(self.pick(images, FakeGit([S1, S2])), (D1, S1), bad)
            if bad != labels(S1):  # a label that disagrees with its tag needs a tag; a digest takes its own label
                with self.assertRaises(draft_manifest.DraftError, msg=bad):
                    self.pick(images, FakeGit([S1, S2]), D2)

    def test_two_images_of_one_commit_or_commits_off_one_line_are_refused(self):
        images = FakeImages({tag(S2): D2, "16.52.0-" + S2[:12]: D3}, {D2: labels(S2), D3: labels(S2)}, attested=(D2, D3))
        with self.assertRaises(draft_manifest.DraftError) as caught:
            self.pick(images, FakeGit([S1, S2]))
        self.assertIn("deployable images of one commit", str(caught.exception))
        images = FakeImages({tag(S1): D1, tag(S3): D3}, {D1: labels(S1), D3: labels(S3)}, attested=(D1, D3))
        with self.assertRaises(draft_manifest.DraftError) as caught:
            self.pick(images, FakeGit([S1, S2, S3], branches={S1: True}))
        self.assertIn("no single newest commit", str(caught.exception))

    def test_the_newest_is_chosen_by_ancestry_even_when_dates_disagree(self):
        # S2 descends from S1; FakeGit has no dates at all, so only ancestry can order them
        images = FakeImages({tag(S2): D2, tag(S1): D1}, {D1: labels(S1), D2: labels(S2)}, attested=(D1, D2))
        self.assertEqual(self.pick(images, FakeGit([S1, S2])), (D2, S2))
        self.assertFalse(hasattr(draft_manifest.Git, "commit_time"))

    def test_a_merge_that_descends_from_every_candidate_is_the_one_newest(self):
        # S1 and S2 are not comparable, S3 merges both: S3 contains every candidate, so it is the newest
        relation = {(S1, S1), (S2, S2), (S3, S3), (S1, S3), (S2, S3)}
        git = FakeGit([S1, S2, S3])
        git.is_ancestor = lambda older, newer: (older, newer) in relation
        images = FakeImages({tag(S1): D1, tag(S2): D2, tag(S3): D3}, {D1: labels(S1), D2: labels(S2), D3: labels(S3)},
                            attested=(D1, D2, D3))
        self.assertEqual(self.pick(images, git), (D3, S3))
        # without the merge there is no single newest commit: refused
        images = FakeImages({tag(S1): D1, tag(S2): D2}, {D1: labels(S1), D2: labels(S2)}, attested=(D1, D2))
        with self.assertRaises(draft_manifest.DraftError):
            self.pick(images, git)

    def test_a_malformed_explicit_digest_is_refused_before_any_lookup(self):
        images = FakeImages({}, {})
        with self.assertRaises(draft_manifest.DraftError):
            self.pick(images, FakeGit([]), "sha256:xyz")
        self.assertEqual(images.checked, [])


class Naming(unittest.TestCase):
    today = datetime.date(2026, 11, 3)

    def test_next_free_number_in_this_month(self):
        self.assertEqual(draft_manifest.next_system(["lab-2026.11.0", "lab-2026.11.2", "lab-2026.10.7"], self.today), "lab-2026.11.3")
        self.assertEqual(draft_manifest.next_system(["lab-2026.10.7"], self.today), "lab-2026.11.0")

    def test_the_newest_manifest_is_by_version_not_by_string(self):
        self.assertEqual(draft_manifest.newest(["lab-2026.11.2", "lab-2026.11.10", "lab-2026.09.1"]), "lab-2026.11.10")


class Draft(unittest.TestCase):
    releases = FakeReleases({"backend-core/v0.4.0": release(), "admin-console/v0.3.0": release()})
    images = FakeImages({tag(S1): D1}, {D1: labels(S1)}, attested=(D1,))

    def make(self, pos="current"):
        return draft_manifest.draft(self.releases, self.images, FakeGit([S1]), current_path=LIVE, system="lab-2026.11.3",
                                    backend="latest", console="latest", erp="latest", pos=pos, base_digest=BASE)

    def test_render_matches_the_hand_written_format_of_the_live_file(self):
        data = json.loads(LIVE.read_text(encoding="utf-8"))
        self.assertEqual(draft_manifest.render(data), LIVE.read_text(encoding="utf-8").replace("\r\n", "\n"))

    def test_draft_builds_the_manifest_and_keeps_the_pos_build_of_the_current_one(self):
        data = self.make()
        self.assertEqual(data["system"], "lab-2026.11.3")
        self.assertEqual(data["backendCore"], {"release": "backend-core/v0.4.0"})
        self.assertEqual(data["erpnext"], {"image": "ghcr.io/kemetra-labs/rt-erpnext@" + D1, "sha": S1})
        self.assertEqual(data["pos"], {"build": POS})
        self.assertIsNone(draft_manifest.system_gate.check_shape(data, "lab-2026.11.3.json"))

    def test_an_explicit_pos_build_must_be_a_full_sha(self):
        with self.assertRaises(draft_manifest.DraftError):
            self.make(pos="9dfd7d9")

    def test_the_gate_runs_before_the_file_exists_and_a_refusal_writes_nothing(self):
        data = self.make()
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            seen = []
            path, code = draft_manifest.gated_write(out, data, lambda p: seen.append(p.name) or 1)
            self.assertEqual((path, code, seen), (None, 1, ["lab-2026.11.3.json"]))
            self.assertEqual(list(out.iterdir()), [])
            path, code = draft_manifest.gated_write(out, data, lambda p: 0)
            self.assertEqual((path.name, code), ("lab-2026.11.3.json", 0))
            self.assertEqual(path.read_text(encoding="utf-8"), draft_manifest.render(data))
            with self.assertRaises(draft_manifest.DraftError):
                draft_manifest.gated_write(out, data, lambda p: 0)  # never overwritten


class Adapters(unittest.TestCase):
    def proc(self, code, out="", err=""):
        return subprocess.CompletedProcess([], code, out, err)

    def test_a_failing_gh_is_an_error_not_an_older_release(self):
        with mock.patch.object(draft_manifest.subprocess, "run", return_value=self.proc(1, err="HTTP 502")):
            with self.assertRaises(draft_manifest.DraftError):
                draft_manifest.GitHubReleases("o/r").states()

    def test_releases_come_from_one_listing_with_immutability(self):
        rows = [{"tagName": "backend-core/v0.4.0", "isDraft": False, "isPrerelease": False, "isImmutable": True}]
        with mock.patch.object(draft_manifest.subprocess, "run", return_value=self.proc(0, json.dumps(rows))) as run:
            states = draft_manifest.GitHubReleases("o/r").states()
        self.assertEqual(states["backend-core/v0.4.0"]["isImmutable"], True)
        self.assertIn("tagName,isDraft,isPrerelease,isImmutable", run.call_args.args[0])

    def test_an_unknown_commit_is_an_error_and_only_exit_1_means_no(self):
        git = draft_manifest.Git(ROOT, "origin/main")
        for code, expected in ((0, True), (1, False)):
            with mock.patch.object(draft_manifest.subprocess, "run", return_value=self.proc(code)):
                self.assertIs(git.is_on_main(S1), expected)
        with mock.patch.object(draft_manifest.subprocess, "run", return_value=self.proc(128, err="bad object")):
            with self.assertRaises(draft_manifest.DraftError):
                git.is_on_main(S1)
            with self.assertRaises(draft_manifest.DraftError):
                git.tree_of(S1, "integrations/erpnext-connector")

    def test_an_http_protocol_error_is_a_draft_error_not_a_traceback(self):
        import http.client
        for error in (http.client.IncompleteRead(b"partial"), http.client.BadStatusLine("x"), OSError("refused")):
            registry = draft_manifest.Registry("o/r")
            with mock.patch.object(draft_manifest.urllib.request, "urlopen", side_effect=error):
                with self.assertRaises(draft_manifest.DraftError, msg=repr(error)):
                    registry.tags()  # the token fetch fails too, and is covered

    def test_a_paged_tag_list_and_content_that_does_not_match_its_digest_are_refused(self):
        registry = draft_manifest.Registry("o/r")
        with mock.patch.object(registry, "_get", return_value=({"Link": "<next>"}, b'{"tags": []}')):
            with self.assertRaises(draft_manifest.DraftError):
                registry.tags()
        body = b'{"config": {"digest": "sha256:' + b"0" * 64 + b'"}}'
        with mock.patch.object(registry, "_get", return_value=({}, body)):
            with self.assertRaises(draft_manifest.DraftError):
                registry.labels_of(D1)  # D1 is not the hash of body
        good = "sha256:" + hashlib.sha256(body).hexdigest()
        config = b'{"config": {"Labels": {"a": "b"}}}'
        replies = iter([({}, body), ({}, config)])
        with mock.patch.object(registry, "_get", side_effect=lambda *a, **k: next(replies)):
            with self.assertRaises(draft_manifest.DraftError):
                registry.labels_of(good)  # the config blob is not the hash of its digest either

    def test_a_stalled_command_is_an_error_not_a_hang(self):
        stall = subprocess.TimeoutExpired(["gh"], 1)
        with mock.patch.object(draft_manifest.subprocess, "run", side_effect=stall) as run:
            with self.assertRaises(draft_manifest.DraftError):
                draft_manifest.GitHubReleases("o/r").states()
            with self.assertRaises(draft_manifest.DraftError):
                draft_manifest.Git(ROOT, "origin/main").is_on_main(S1)
            with self.assertRaises(draft_manifest.DraftError):
                draft_manifest.Registry("o/r").is_attested(D1)
        self.assertTrue(all(call.kwargs.get("timeout") for call in run.call_args_list))

    def test_a_failed_write_leaves_no_partial_file(self):
        data = Draft.make(Draft())
        with tempfile.TemporaryDirectory() as tmp:
            real_open = open

            def failing_open(path, mode="r", *args, **kwargs):
                handle = real_open(path, mode, *args, **kwargs)
                if mode == "x":
                    handle.write = mock.Mock(side_effect=OSError("disk full"))
                return handle

            with mock.patch("builtins.open", failing_open):
                with self.assertRaises(draft_manifest.DraftError):
                    draft_manifest.gated_write(tmp, data, lambda p: 0)
            self.assertEqual(list(pathlib.Path(tmp).iterdir()), [])

    def test_the_pinned_base_is_read_from_the_deploy_workflow(self):
        self.assertRegex(draft_manifest.pinned_base(), r"^sha256:[0-9a-f]{64}$")

    def test_only_a_passing_attestation_verification_counts(self):
        registry = draft_manifest.Registry("o/r")
        with mock.patch.object(draft_manifest.subprocess, "run", return_value=self.proc(0)) as run:
            self.assertTrue(registry.is_attested(D1))
        argv = run.call_args.args[0]
        self.assertEqual(argv[:4], ["gh", "attestation", "verify", "oci://ghcr.io/kemetra-labs/rt-erpnext@" + D1])
        self.assertIn("--source-ref", argv)
        self.assertEqual(argv[argv.index("--signer-workflow") + 1], draft_manifest.SIGNER)
        for code in (1, 2):
            with mock.patch.object(draft_manifest.subprocess, "run", return_value=self.proc(code, err="no attestation")), \
                    contextlib.redirect_stderr(io.StringIO()):
                self.assertFalse(registry.is_attested(D1))


class Cli(unittest.TestCase):
    """main()'s exit codes: 0 written or printed, 1 refused by the gate, 2 no draft; never a stray file."""

    data = Draft.make(Draft())

    @staticmethod
    def fake_stdout(buffer):
        # Python 3.14's argparse asks sys.stdout whether it is a terminal (colour); a bare Mock cannot answer.
        return mock.Mock(buffer=buffer, fileno=mock.Mock(side_effect=io.UnsupportedOperation),
                         isatty=mock.Mock(return_value=False))

    def run_main(self, out, *argv, draft=None, gate_code=0):
        (pathlib.Path(out) / "lab-2026.11.2.json").write_text(LIVE.read_text(encoding="utf-8"), encoding="utf-8")
        gate = subprocess.CompletedProcess([], gate_code, "", "")
        stdout = io.BytesIO()
        with mock.patch.object(draft_manifest, "draft", **(draft or {"return_value": self.data})), \
                mock.patch.object(draft_manifest, "pinned_base", return_value=BASE), \
                mock.patch.object(draft_manifest.subprocess, "run", return_value=gate), \
                mock.patch.object(draft_manifest.sys, "stdout", self.fake_stdout(stdout)), \
                contextlib.redirect_stderr(io.StringIO()):
            code = draft_manifest.main(["--out-dir", str(out), *argv])
        return code, sorted(p.name for p in pathlib.Path(out).iterdir()), stdout.getvalue().decode("utf-8")

    def test_print_exits_0_without_writing(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, files, printed = self.run_main(tmp, "--print")
        self.assertEqual((code, files), (0, ["lab-2026.11.2.json"]))
        self.assertEqual(printed, draft_manifest.render(self.data))

    def test_a_passing_gate_writes_and_exits_0(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, files, _ = self.run_main(tmp, "--system", "lab-2026.11.3")
        self.assertEqual((code, files), (0, ["lab-2026.11.2.json", "lab-2026.11.3.json"]))

    def test_a_gate_refusal_exits_1_and_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, files, _ = self.run_main(tmp, "--system", "lab-2026.11.3", gate_code=1)
        self.assertEqual((code, files), (1, ["lab-2026.11.2.json"]))

    def test_a_gate_that_cannot_evaluate_exits_2_not_1(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, files, _ = self.run_main(tmp, "--system", "lab-2026.11.3", gate_code=2)
        self.assertEqual((code, files), (2, ["lab-2026.11.2.json"]))

    def test_no_draft_exits_2_and_writes_nothing(self):
        for failure in (draft_manifest.DraftError("no attested image"), FileNotFoundError("gh"), FileNotFoundError("git")):
            with tempfile.TemporaryDirectory() as tmp:
                code, files, _ = self.run_main(tmp, "--system", "lab-2026.11.3", draft={"side_effect": failure})
            self.assertEqual((code, files), (2, ["lab-2026.11.2.json"]), failure)
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(self.run_main(tmp, "--system", "lab-2026.1.3")[0], 2)
            self.assertEqual(self.run_main(tmp, "--main=--upload-pack=x")[0], 2)


if __name__ == "__main__":
    unittest.main()

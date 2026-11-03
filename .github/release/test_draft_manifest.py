"""RT-1089: tests of draft_manifest.py, the drafting helper for the next system release manifest.

The choices (which release is the latest, which ERP image, which file name) are pure functions,
tested here with fake sources; the GitHub, registry and git adapters are thin and are proven by the
AC2 run against main (reproducing system/releases/lab-2026.11.2.json from the same inputs).
"""
import datetime
import json
import pathlib
import tempfile
import unittest

import draft_manifest

ROOT = pathlib.Path(__file__).resolve().parents[2]
LIVE = ROOT / "system" / "releases" / "lab-2026.11.2.json"
D1, D2, D3 = ("sha256:" + c * 64 for c in "123")
S1, S2, S3 = ("a" * 40, "b" * 40, "c" * 40)
POS = "9dfd7d977267806a907d4c03a566382570cbd0c9"


class FakeReleases:
    def __init__(self, releases):
        self.releases = releases  # {tag: {"isDraft", "isPrerelease", "isImmutable"}}

    def tags(self):
        return list(self.releases)

    def state(self, tag):
        return self.releases.get(tag)


class FakeImages:
    def __init__(self, images, attested=()):
        self.images = images  # {tag: (digest, revision)}
        self.attested = set(attested)

    def tags(self):
        return list(self.images)

    def digest_of(self, tag):
        return self.images[tag][0]

    def revision_of(self, digest):
        return next((rev for dig, rev in self.images.values() if dig == digest), None)

    def is_attested(self, digest):
        return digest in self.attested


class FakeGit:
    def __init__(self, on_main, times):
        self.on_main, self.times = set(on_main), times

    def is_on_main(self, sha):
        return sha in self.on_main

    def commit_time(self, sha):
        return self.times[sha]


def release(draft=False, pre=False, immutable=True):
    return {"isDraft": draft, "isPrerelease": pre, "isImmutable": immutable}


class Releases(unittest.TestCase):
    source = FakeReleases({
        "backend-core/v0.3.3": release(), "backend-core/v0.10.0": release(), "backend-core/v0.11.0": release(draft=True),
        "backend-core/v0.12.0": release(pre=True), "backend-core/v0.13.0": release(immutable=False),
        "admin-console/v0.3.0": release(), "pos/v1.0.0": release(),
    })

    def test_latest_is_the_highest_published_immutable_version_not_the_newest_string(self):
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
    images = FakeImages({"16.51.0-" + S1[:12]: (D1, S1), "16.51.0-" + S2[:12]: (D2, S2), "16.51.0-" + S3[:12]: (D3, S3),
                         "sha256-" + "1" * 64: (D1, None), "latest": (D3, S3)}, attested=(D1, D2))
    git = FakeGit(on_main=(S1, S2), times={S1: 100, S2: 200, S3: 300})

    def test_latest_is_the_attested_image_of_the_newest_commit_on_main(self):
        # S3 is newer but neither attested nor on main
        self.assertEqual(draft_manifest.pick_erp(self.images, self.git, "latest"), (D2, S2))

    def test_an_explicit_digest_is_checked_the_same_way(self):
        self.assertEqual(draft_manifest.pick_erp(self.images, self.git, D1), (D1, S1))
        for bad in (D3, "sha256:" + "9" * 64, "sha256:xyz"):
            with self.assertRaises(draft_manifest.DraftError, msg=bad):
                draft_manifest.pick_erp(self.images, self.git, bad)

    def test_an_image_whose_revision_does_not_match_its_tag_is_ignored(self):
        images = FakeImages({"16.51.0-" + S1[:12]: (D2, S2)}, attested=(D2,))
        with self.assertRaises(draft_manifest.DraftError):
            draft_manifest.pick_erp(images, self.git, "latest")


class Naming(unittest.TestCase):
    today = datetime.date(2026, 11, 3)

    def test_next_free_number_in_this_month(self):
        names = ["lab-2026.11.0", "lab-2026.11.2", "lab-2026.10.7"]
        self.assertEqual(draft_manifest.next_system(names, self.today), "lab-2026.11.3")
        self.assertEqual(draft_manifest.next_system(["lab-2026.10.7"], self.today), "lab-2026.11.0")

    def test_the_newest_manifest_is_by_version_not_by_string(self):
        self.assertEqual(draft_manifest.newest(["lab-2026.11.2", "lab-2026.11.10", "lab-2026.9.1"]), "lab-2026.11.10")


class Render(unittest.TestCase):
    def test_render_matches_the_hand_written_format_of_the_live_file(self):
        data = json.loads(LIVE.read_text(encoding="utf-8"))
        text = draft_manifest.render(data)
        self.assertEqual(text, LIVE.read_text(encoding="utf-8").replace("\r\n", "\n"))

    def test_draft_builds_the_manifest_and_keeps_the_pos_build_of_the_current_one(self):
        releases = FakeReleases({"backend-core/v0.4.0": release(), "admin-console/v0.3.0": release()})
        images = FakeImages({"16.51.0-" + S1[:12]: (D1, S1)}, attested=(D1,))
        git = FakeGit(on_main=(S1,), times={S1: 1})
        with tempfile.TemporaryDirectory() as tmp:
            current = pathlib.Path(tmp) / "lab-2026.11.2.json"
            current.write_text(LIVE.read_text(encoding="utf-8"), encoding="utf-8")
            data = draft_manifest.draft(releases, images, git, current_path=current, system="lab-2026.11.3",
                                        backend="latest", console="latest", erp="latest", pos="current")
        self.assertEqual(data["system"], "lab-2026.11.3")
        self.assertEqual(data["backendCore"], {"release": "backend-core/v0.4.0"})
        self.assertEqual(data["erpnext"], {"image": "ghcr.io/kemetra-labs/rt-erpnext@" + D1, "sha": S1})
        self.assertEqual(data["pos"], {"build": POS})
        self.assertIsNone(draft_manifest.system_gate.check_shape(data, "lab-2026.11.3.json"))

    def test_an_explicit_pos_build_must_be_a_full_sha(self):
        releases = FakeReleases({"backend-core/v0.4.0": release(), "admin-console/v0.3.0": release()})
        images = FakeImages({"16.51.0-" + S1[:12]: (D1, S1)}, attested=(D1,))
        with self.assertRaises(draft_manifest.DraftError):
            draft_manifest.draft(releases, images, FakeGit((S1,), {S1: 1}), current_path=LIVE, system="lab-2026.11.3",
                                 backend="latest", console="latest", erp="latest", pos="9dfd7d9")


class Cli(unittest.TestCase):
    def test_an_existing_file_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp)
            (out / "lab-2026.11.2.json").write_text("{}", encoding="utf-8")
            with self.assertRaises(draft_manifest.DraftError):
                draft_manifest.write_new(out, {"system": "lab-2026.11.2"})


if __name__ == "__main__":
    unittest.main()

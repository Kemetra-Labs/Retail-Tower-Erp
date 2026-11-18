"""Unit tests for size_guard.py, run against throwaway git repositories (stdlib only)."""
from __future__ import annotations

import io
import json
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import size_guard as sg

CFG = "tools/size-guard/config.json"
LFS_POINTER = b"version https://git-lfs.github.com/spec/v1\noid sha256:" + b"a" * 64 + b"\nsize 1048576\n"


def config(allowlist=None, threshold=1000, budget=5000, exts=("png", "pdf")) -> str:
    return json.dumps(
        {"threshold_bytes": threshold, "pr_budget_bytes": budget, "binary_extensions": list(exts), "allowlist": allowlist or {}}
    )


class Repo:
    def __init__(self, root: str) -> None:
        self.root = root
        self.run("init", "-q", "-b", "main")
        self.run("config", "user.email", "t@example.invalid")
        self.run("config", "user.name", "t")
        self.run("config", "commit.gpgsign", "false")

    def run(self, *args: str) -> str:
        return subprocess.run(["git", "-C", self.root, *args], check=True, capture_output=True, text=True).stdout.strip()

    def write(self, path: str, data: bytes | str) -> None:
        full = Path(self.root, path)
        full.parent.mkdir(parents=True, exist_ok=True)
        full.write_bytes(data if isinstance(data, bytes) else data.encode())

    def commit(self, msg: str) -> str:
        self.run("add", "-A")
        self.run("commit", "-q", "-m", msg)
        return self.run("rev-parse", "HEAD")


class SizeGuardTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.repo = Repo(self._tmp.name)
        self.repo.write(CFG, config({"docs/old.png": 2000}))
        self.repo.write("docs/old.png", b"x" * 2000)
        self.repo.write("docs/small.png", b"x" * 900)
        self.base = self.repo.commit("base")

    def check(self, base=None):
        return sg.check(self.repo.root, base, "HEAD", CFG)

    def test_clean_tree_passes(self):
        errors, _ = self.check(self.base)
        self.assertEqual(errors, [])

    def test_new_one_megabyte_png_fails(self):
        self.repo.write("docs/new.png", b"x" * 1_048_576)
        self.repo.commit("add")
        errors, _ = self.check(self.base)
        self.assertTrue(any("docs/new.png" in e and "not in LFS or the allowlist" in e for e in errors), errors)

    def test_same_file_as_lfs_pointer_passes(self):
        self.repo.write("docs/new.png", LFS_POINTER)
        self.repo.commit("add pointer")
        errors, _ = self.check(self.base)
        self.assertEqual(errors, [])

    def test_allowlisted_file_that_grows_fails(self):
        self.repo.write("docs/old.png", b"x" * 2001)
        self.repo.commit("grow")
        errors, _ = self.check(self.base)
        self.assertTrue(any("grew to 2001" in e for e in errors), errors)

    def test_non_binary_extension_is_out_of_scope(self):
        self.repo.write("src/generated/schema.d.ts", b"x" * 50_000)
        self.repo.commit("generated text")
        errors, _ = self.check(self.base)
        self.assertEqual(errors, [])

    def test_extension_match_is_case_insensitive(self):
        self.repo.write("docs/SHOT.PNG", b"x" * 1500)
        self.repo.commit("upper")
        errors, _ = self.check(self.base)
        self.assertTrue(any("docs/SHOT.PNG" in e for e in errors), errors)

    def test_many_small_files_exceed_the_pr_budget(self):
        for i in range(8):
            self.repo.write(f"docs/cap-{i}.png", b"x" * 900)
        self.repo.commit("captures")
        errors, notes = self.check(self.base)
        self.assertTrue(any("over the 5000-byte budget" in e for e in errors), errors)
        self.assertTrue(any("7200 of 5000" in n for n in notes), notes)

    def test_small_additions_within_budget_pass(self):
        self.repo.write("docs/cap-a.png", b"x" * 900)
        self.repo.write("docs/cap-b.png", b"x" * 900)
        self.repo.commit("two")
        errors, _ = self.check(self.base)
        self.assertEqual(errors, [])

    def test_shrinking_a_file_does_not_count_against_the_budget(self):
        self.repo.write("docs/small.png", b"x" * 100)
        self.repo.commit("shrink")
        errors, notes = self.check(self.base)
        self.assertEqual(errors, [])
        self.assertTrue(any("0 of 5000" in n for n in notes), notes)

    def test_new_allowlist_entry_is_rejected(self):
        self.repo.write("docs/new.png", b"x" * 3000)
        self.repo.write(CFG, config({"docs/old.png": 2000, "docs/new.png": 3000}))
        self.repo.commit("sneak")
        errors, _ = self.check(self.base)
        self.assertTrue(any("allowlist gained docs/new.png" in e for e in errors), errors)

    def test_raised_entry_threshold_and_budget_are_rejected(self):
        self.repo.write("docs/old.png", b"x" * 2500)
        self.repo.write(CFG, config({"docs/old.png": 2500}, threshold=2000, budget=9000))
        self.repo.commit("loosen")
        errors, _ = self.check(self.base)
        joined = "\n".join(errors)
        self.assertIn("raised from 2000 to 2500", joined)
        self.assertIn("threshold_bytes was raised", joined)
        self.assertIn("pr_budget_bytes was raised", joined)

    def test_removing_an_extension_is_rejected(self):
        self.repo.write(CFG, config({"docs/old.png": 2000}, exts=("png",)))
        self.repo.commit("narrow")
        errors, _ = self.check(self.base)
        self.assertTrue(any("lost ['pdf']" in e for e in errors), errors)

    def test_deleting_a_file_requires_removing_its_entry(self):
        self.repo.run("rm", "-q", "docs/old.png")
        self.repo.commit("delete only")
        errors, _ = self.check(self.base)
        self.assertTrue(any("no longer exists" in e for e in errors), errors)

    def test_deleting_a_file_and_its_entry_passes(self):
        self.repo.run("rm", "-q", "docs/old.png")
        self.repo.write(CFG, config({}))
        self.repo.commit("delete both")
        errors, _ = self.check(self.base)
        self.assertEqual(errors, [])

    def test_shrunk_file_needs_a_lowered_entry(self):
        self.repo.write("docs/old.png", b"x" * 1500)
        self.repo.commit("shrink")
        errors, _ = self.check(self.base)
        self.assertTrue(any("lower the entry to 1500" in e for e in errors), errors)

    def test_entry_at_or_under_threshold_is_stale(self):
        self.repo.write("docs/old.png", b"x" * 900)
        self.repo.commit("tiny")
        errors, _ = self.check(self.base)
        self.assertTrue(any("not over the threshold" in e for e in errors), errors)

    def test_renaming_a_grandfathered_file_may_carry_its_entry(self):
        self.repo.run("mv", "docs/old.png", "docs/moved.png")
        self.repo.write(CFG, config({"docs/moved.png": 2000}))
        self.repo.commit("move")
        errors, notes = self.check(self.base)
        self.assertEqual(errors, [])
        self.assertTrue(any("0 of 5000" in n for n in notes), notes)

    def test_no_base_skips_base_rules_but_still_scans(self):
        self.repo.write("docs/new.png", b"x" * 1500)
        self.repo.commit("add")
        errors, notes = self.check(None)
        self.assertEqual(len(errors), 1)
        self.assertTrue(any("skipped" in n for n in notes), notes)

    def test_missing_base_config_is_a_bootstrap_note(self):
        self.repo.run("rm", "-q", "-f", CFG)
        first = self.repo.commit("no config")
        self.repo.write(CFG, config({"docs/old.png": 2000}))
        self.repo.commit("add config")
        errors, notes = self.check(first)
        self.assertEqual(errors, [])
        self.assertTrue(any("bootstrap" in n for n in notes), notes)

    def test_missing_head_config_is_unreadable_input(self):
        self.repo.run("rm", "-q", "-f", CFG)
        self.repo.commit("drop config")
        with self.assertRaises(sg.GuardError):
            self.check(self.base)

    def test_invalid_config_is_rejected(self):
        for raw in ("not json", json.dumps({"threshold_bytes": 1}), config(threshold=0), config(exts=(".png",)), config({"a": "b"})):
            with self.subTest(raw=raw[:30]), self.assertRaises(sg.GuardError):
                sg.parse_config(raw.encode(), "t")

    def test_generate_lists_only_over_threshold_binaries(self):
        generated = sg.generate(self.repo.root, "HEAD", CFG)
        self.assertEqual(generated["allowlist"], {"docs/old.png": 2000})

    def test_cli_exit_codes(self):
        self.repo.write("docs/new.png", b"x" * 1500)
        self.repo.commit("add")
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            self.assertEqual(sg.main(["check", "--repo", self.repo.root, "--base", self.base]), 1)
            self.assertEqual(sg.main(["check", "--repo", self.repo.root, "--base", "nope"]), 2)
        self.assertIn("docs/new.png", out.getvalue())
        self.repo.run("rm", "-q", "docs/new.png")
        self.repo.commit("remove")
        with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
            self.assertEqual(sg.main(["check", "--repo", self.repo.root, "--base", self.base]), 0)


if __name__ == "__main__":
    unittest.main()

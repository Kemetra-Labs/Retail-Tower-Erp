"""RT-1030: --backend-rev / --consumer-rev read the PIN and the contract from commits, not the tree."""
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from contracts_check import cli, pins
from contracts_check.findings import DRIFT, FAIL, OK

from support import TempRepo, fake_oasdiff

THIS_REPO = "Kemetra-Labs/Retail-Tower-Erp"
SPEC = "openapi: 3.1.0\ninfo: {title: t, version: 1.0.0}\npaths: {}\n"


def base_commit(repo):
    """A commit holding contracts/a.yaml = SPEC, then removed again so each test starts from an empty
    tree. PIN headers name it: RT-1407 checks every pinned blob against the PIN's real `commit:`."""
    repo.write("contracts/a.yaml", SPEC)
    base = repo.commit_all()
    repo.git("rm", "-q", "contracts/a.yaml")
    repo.commit_all()
    return base


def header(commit, repo=THIS_REPO):
    return f"repo: {repo}\ncommit: {commit}\nsource: contracts\n"


class RevisionCase(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.bin = tempfile.TemporaryDirectory(prefix="cc-bin-")
        self.addCleanup(self.bin.cleanup)
        self.blob = self.repo.blob(SPEC)
        self.base = base_commit(self.repo)

    def commit(self, files):
        for rel, text in files.items():
            self.repo.write(rel, text)
        self.repo.git("add", "-A")
        self.repo.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c")
        return self.repo.git("rev-parse", "HEAD")

    def check(self, **revs):
        return pins.check_consumer(self.repo.root, {"name": "Admin-Console", "pin": "app/PIN"}, "contracts",
                                   fake_oasdiff(self.bin.name), None, repository=THIS_REPO, **revs)

    def test_contract_is_read_at_the_backend_rev(self):
        old = self.commit({"contracts/a.yaml": SPEC, "app/PIN": f"{header(self.base)}file: a.yaml {self.blob}\n"})
        self.commit({"contracts/b.yaml": SPEC})
        self.repo.git("rm", "-q", "contracts/a.yaml")
        self.commit({})
        # gone from HEAD and the tree, present at the backend rev
        [tree] = self.check()
        self.assertEqual(tree.status, FAIL)
        self.assertEqual([f.status for f in self.check(backend_rev=old)], [OK])

    def test_a_file_missing_at_the_backend_rev_fails(self):
        old = self.commit({"app/PIN": f"{header(self.base)}file: a.yaml {self.blob}\n", "contracts/b.yaml": SPEC})
        self.commit({"contracts/a.yaml": SPEC})
        [f] = self.check(backend_rev=old)
        self.assertEqual(f.status, FAIL)
        self.assertIn(f"does not exist at {old}", f.message)

    def test_pin_is_read_at_the_consumer_rev(self):
        old = self.commit({"contracts/a.yaml": SPEC, "app/PIN": f"{header(self.base, 'Kemetra/Backend-Core')}file: a.yaml {self.blob}\n"})
        self.commit({"app/PIN": f"{header(self.base)}file: a.yaml {self.blob}\n"})
        [f] = self.check(pin_rev=old)
        self.assertEqual(f.status, FAIL)
        self.assertIn("PIN names repo 'Kemetra/Backend-Core'", f.message)

    def test_a_pin_missing_at_the_consumer_rev_fails(self):
        old = self.commit({"contracts/a.yaml": SPEC})
        self.commit({"app/PIN": f"{header(self.base)}file: a.yaml {self.blob}\n"})
        [f] = self.check(pin_rev=old)
        self.assertEqual(f.status, FAIL)
        self.assertIn("unreadable PIN", f.message)

    # RT-1407 in release-gate mode: the one-commit rule and the stale line hold for a PIN read at
    # `pin_rev` against the contract at `backend_rev`, as the System release gate runs them.

    def test_partial_pin_at_the_consumer_rev_fails(self):
        newer = SPEC.replace("1.0.0", "1.1.0")
        later = self.commit({"contracts/a.yaml": newer})
        rev = self.commit({"app/PIN": f"{header(self.base)}file: a.yaml {self.repo.blob(newer)}\n"})
        [f] = self.check(pin_rev=rev, backend_rev=later)
        self.assertEqual(f.status, FAIL)
        self.assertIn("partial pin", f.message)

    def test_missing_commit_at_the_consumer_rev_fails(self):
        rev = self.commit({"contracts/a.yaml": SPEC, "app/PIN": f"{header('f' * 40)}file: a.yaml {self.blob}\n"})
        [f] = self.check(pin_rev=rev, backend_rev=rev)
        self.assertEqual(f.status, FAIL)
        self.assertIn("is not a commit", f.message)

    def test_stale_line_names_the_backend_rev(self):
        newer = SPEC.replace("1.0.0", "1.1.0")
        rev = self.commit({"contracts/a.yaml": newer, "app/PIN": f"{header(self.base)}file: a.yaml {self.blob}\n"})
        findings = self.check(pin_rev=rev, backend_rev=rev)
        self.assertEqual(sorted(f.status for f in findings), [DRIFT, OK])
        [stale] = [f for f in findings if f.status == DRIFT]
        self.assertIn(f"stale pin: pinned blob {self.blob}", stale.message)
        self.assertIn(f"at {rev}", stale.message)


class RevisionCli(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        base = base_commit(self.repo)
        self.repo.write("contracts/a.yaml", SPEC)
        self.repo.write("one/PIN", f"{header(base)}file: a.yaml {self.repo.blob(SPEC)}\n")
        self.repo.write("two/PIN", "garbage\n")
        self.repo.git("add", "-A")
        self.repo.git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c")
        self.head = self.repo.git("rev-parse", "HEAD")
        self.config = self.repo.write("config.yaml", f"""\
            repository: {THIS_REPO}
            contracts_root: contracts
            consumers: [{{name: One, pin: one/PIN}}, {{name: Two, pin: two/PIN}}]
            connector: [{{module: m.py, contract: c.yaml}}]
            identical: [{{name: V, paths: [a, b]}}]
            """)

    def call(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = cli.main(["--repo", str(self.repo.root), "--config", str(self.config), "--only", "pins",
                             "--oasdiff", "/nonexistent/oasdiff", *argv])
        return code, out.getvalue(), err.getvalue()

    def test_consumer_rev_runs_only_the_named_consumers(self):
        # Two's PIN is garbage: naming only One must leave Two out of the run
        _, out, _ = self.call("--backend-rev", self.head, "--consumer-rev", f"One={self.head}")
        self.assertIn("One", out)
        self.assertNotIn("Two", out)

    def test_unknown_consumer_or_unresolvable_rev_is_a_configuration_error(self):
        for argv in (["--consumer-rev", f"Nobody={self.head}"], ["--consumer-rev", "One=" + "f" * 40],
                     ["--backend-rev", "no-such-ref"], ["--consumer-rev", "One"]):
            with self.subTest(argv=argv):
                code, _, err = self.call(*argv)
                self.assertEqual(code, 2)
                self.assertIn("configuration error", err)


if __name__ == "__main__":
    unittest.main()

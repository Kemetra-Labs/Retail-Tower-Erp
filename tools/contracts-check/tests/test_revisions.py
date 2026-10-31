"""RT-1030: --backend-rev / --consumer-rev read the PIN and the contract from commits, not the tree."""
import io
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

from contracts_check import cli, pins
from contracts_check.findings import FAIL, OK

from support import TempRepo, fake_oasdiff

THIS_REPO = "Kemetra-Labs/Retail-Tower-Erp"
SPEC = "openapi: 3.1.0\ninfo: {title: t, version: 1.0.0}\npaths: {}\n"


def header(repo=THIS_REPO):
    return f"repo: {repo}\ncommit: {'a' * 40}\nsource: contracts\n"


class RevisionCase(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.bin = tempfile.TemporaryDirectory(prefix="cc-bin-")
        self.addCleanup(self.bin.cleanup)
        self.blob = self.repo.blob(SPEC)

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
        old = self.commit({"contracts/a.yaml": SPEC, "app/PIN": f"{header()}file: a.yaml {self.blob}\n"})
        self.commit({"contracts/b.yaml": SPEC})
        self.repo.git("rm", "-q", "contracts/a.yaml")
        self.commit({})
        # gone from HEAD and the tree, present at the backend rev
        [tree] = self.check()
        self.assertEqual(tree.status, FAIL)
        self.assertEqual([f.status for f in self.check(backend_rev=old)], [OK])

    def test_a_file_missing_at_the_backend_rev_fails(self):
        old = self.commit({"app/PIN": f"{header()}file: a.yaml {self.blob}\n", "contracts/b.yaml": SPEC})
        self.commit({"contracts/a.yaml": SPEC})
        [f] = self.check(backend_rev=old)
        self.assertEqual(f.status, FAIL)
        self.assertIn(f"does not exist at {old}", f.message)

    def test_pin_is_read_at_the_consumer_rev(self):
        old = self.commit({"contracts/a.yaml": SPEC, "app/PIN": f"{header('Kemetra/Backend-Core')}file: a.yaml {self.blob}\n"})
        self.commit({"app/PIN": f"{header()}file: a.yaml {self.blob}\n"})
        [f] = self.check(pin_rev=old)
        self.assertEqual(f.status, FAIL)
        self.assertIn("PIN names repo 'Kemetra/Backend-Core'", f.message)

    def test_a_pin_missing_at_the_consumer_rev_fails(self):
        old = self.commit({"contracts/a.yaml": SPEC})
        self.commit({"app/PIN": f"{header()}file: a.yaml {self.blob}\n"})
        [f] = self.check(pin_rev=old)
        self.assertEqual(f.status, FAIL)
        self.assertIn("unreadable PIN", f.message)


class RevisionCli(unittest.TestCase):
    def setUp(self):
        self.repo = TempRepo()
        self.addCleanup(self.repo.close)
        self.repo.write("contracts/a.yaml", SPEC)
        self.repo.write("one/PIN", f"{header()}file: a.yaml {self.repo.blob(SPEC)}\n")
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

"""Unit tests of workflow_lint_baseline.py (RT-1459, audit A-14). Stdlib only: run with
`python3 -m unittest discover -s .github/scripts -p 'test_workflow_lint_baseline.py' -v`."""
import contextlib
import io
import json
import os
import tempfile
import unittest

import workflow_lint_baseline as wlb


def al(file, kind, message, line=10):
    return {"message": message, "filepath": file, "line": line, "column": 3, "kind": kind, "snippet": "x", "end_column": 5}


def zz(file, ident, desc, annotation, row=5, ignored=False):
    return {
        "ident": ident,
        "desc": desc,
        "ignored": ignored,
        "locations": [
            {"symbolic": {"key": {"Local": {"verbatim_path": file}}, "annotation": "this workflow", "kind": "Hidden"}},
            {
                "symbolic": {"key": {"Local": {"verbatim_path": file}}, "annotation": annotation, "kind": "Primary"},
                "concrete": {"location": {"start_point": {"row": row, "column": 1}}, "feature": "f"},
            },
        ],
    }


SC = "shellcheck reported issue in this script: SC2015:info:{pos}: Note that A && B || C is not if-then-else"
INJECTION = zz(".github/workflows/a.yml", "template-injection", "code injection via template expansion", "may expand into attacker-controllable code")


class Case(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def write(self, name, content):
        path = os.path.join(self.dir.name, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(content if isinstance(content, str) else json.dumps(content))
        return path

    def check(self, tool, rc, findings, baseline_lines, summary=None, plain=None):
        argv = ["check", "--tool", tool, "--rc", str(rc), "--findings", self.write("f.json", findings),
                "--baseline", self.write("b.txt", "\n".join(baseline_lines) + "\n")]
        if summary:
            argv += ["--summary", summary]
        if plain:
            argv += ["--plain", plain]
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = wlb.main(argv)
        return code, out.getvalue(), err.getvalue()


class Normalise(Case):
    def test_actionlint_line_numbers_and_script_positions_are_dropped(self):
        a = wlb.normalise_actionlint([al(".github/workflows/a.yml", "shellcheck", SC.format(pos="2:44"), line=281)])
        b = wlb.normalise_actionlint([al(".github/workflows/a.yml", "shellcheck", SC.format(pos="7:1"), line=912)])
        self.assertEqual(a, b)
        self.assertEqual(a[0].split("|")[:3], ["actionlint", ".github/workflows/a.yml", "shellcheck"])
        self.assertNotIn("2:44", a[0])

    def test_zizmor_line_numbers_are_dropped_and_ignored_findings_skipped(self):
        moved = zz(".github/workflows/a.yml", "template-injection", "code injection via template expansion", "may expand into attacker-controllable code", row=99)
        self.assertEqual(wlb.normalise_zizmor([INJECTION]), wlb.normalise_zizmor([moved]))
        ignored = zz(".github/workflows/a.yml", "cache-poisoning", "d", "a", ignored=True)
        self.assertEqual(wlb.normalise_zizmor([ignored]), [])
        self.assertEqual(
            wlb.normalise_zizmor([INJECTION]),
            ["zizmor|.github/workflows/a.yml|template-injection|code injection via template expansion: may expand into attacker-controllable code"],
        )

    def test_a_pipe_in_the_message_does_not_break_the_line_format(self):
        line = wlb.normalise_actionlint([al("f.yml", "expression", "a | b")])[0]
        self.assertEqual(line.split("|", 3)[3], "a | b")


class Check(Case):
    def test_equal_to_the_baseline_passes_and_comments_are_ignored(self):
        base = wlb.normalise_zizmor([INJECTION])
        code, out, _ = self.check("zizmor", 14, [INJECTION], ["# a comment", "", *base])
        self.assertEqual(code, 0, out)

    def test_a_new_finding_fails_and_is_printed(self):
        # The A-14 fixture: an inline `${{ github.event.pull_request.title }}` in `run:` adds a finding.
        code, out, _ = self.check("zizmor", 14, [INJECTION], [])
        self.assertEqual(code, 1)
        self.assertIn("NEW      zizmor|.github/workflows/a.yml|template-injection", out)

    def test_an_identical_extra_finding_is_new_because_findings_are_counted(self):
        base = wlb.normalise_zizmor([INJECTION])
        code, out, _ = self.check("zizmor", 14, [INJECTION, INJECTION], base)
        self.assertEqual(code, 1)
        self.assertIn("1 new", out)

    def test_a_stale_baseline_line_fails_so_the_baseline_only_shrinks(self):
        base = wlb.normalise_zizmor([INJECTION])
        code, out, _ = self.check("zizmor", 0, [], base)
        self.assertEqual(code, 1)
        self.assertIn("STALE    zizmor|", out)

    def test_a_pure_move_of_a_finding_passes(self):
        base = wlb.normalise_actionlint([al("f.yml", "shellcheck", SC.format(pos="2:44"), line=281)])
        moved = [al("f.yml", "shellcheck", SC.format(pos="9:3"), line=640)]
        code, out, _ = self.check("actionlint", 1, moved, base)
        self.assertEqual(code, 0, out)

    def test_only_the_named_tools_baseline_lines_are_compared(self):
        base = wlb.normalise_zizmor([INJECTION]) + wlb.normalise_actionlint([al("f.yml", "shellcheck", "x")])
        code, out, _ = self.check("actionlint", 1, [al("f.yml", "shellcheck", "x")], base)
        self.assertEqual(code, 0, out)

    def test_actionlint_null_output_is_an_empty_list(self):
        self.assertEqual(self.check("actionlint", 0, None, [])[0], 0)

    def test_fails_closed_on_a_tool_failure_unreadable_json_or_a_missing_baseline(self):
        for tool, rc in (("actionlint", 2), ("actionlint", 3), ("zizmor", 1), ("zizmor", 2), ("zizmor", 3)):
            self.assertEqual(self.check(tool, rc, [], [])[0], 1, (tool, rc))
        self.assertEqual(self.check("zizmor", 0, "not json", [])[0], 1)
        self.assertEqual(self.check("zizmor", 0, {"a": 1}, [])[0], 1)
        code = wlb.main(["check", "--tool", "zizmor", "--rc", "0", "--findings", self.write("f.json", []),
                         "--baseline", os.path.join(self.dir.name, "missing.txt")])
        self.assertEqual(code, 1)

    def test_every_documented_findings_code_is_accepted_and_a_tool_failure_is_in_the_summary(self):
        for rc in (10, 11, 12, 13, 14):
            self.assertEqual(self.check("zizmor", rc, [], [])[0], 0, rc)
        for rc in (0, 1):
            self.assertEqual(self.check("actionlint", rc, [], [])[0], 0, rc)
        summary = os.path.join(self.dir.name, "fail.md")
        self.assertEqual(self.check("zizmor", 1, [], [], summary=summary)[0], 1)
        with open(summary, encoding="utf-8") as handle:
            self.assertIn("FAILED, the tool did not lint", handle.read())

    def test_input_shapes_that_cannot_be_read_fail_closed(self):
        no_primary = {"ident": "x", "desc": "d", "ignored": False, "locations": [{"symbolic": {"kind": "Hidden", "key": {}}}]}
        self.assertEqual(self.check("zizmor", 14, [no_primary], [])[0], 1)
        self.assertEqual(self.check("actionlint", 1, [{"filepath": "f.yml", "kind": "expression"}], [])[0], 1)
        self.assertEqual(self.check("zizmor", 14, [{"desc": "no ident"}], [])[0], 1)

    def test_a_malformed_baseline_line_fails(self):
        self.assertEqual(self.check("zizmor", 0, [], ["not a baseline line"])[0], 1)
        self.assertEqual(self.check("zizmor", 0, [], ["zizmor|only|three"])[0], 1)

    def test_summary_lists_new_findings_first_and_keeps_the_tool_report(self):
        summary = os.path.join(self.dir.name, "summary.md")
        plain = self.write("plain.txt", "the full report\n")
        base = ["zizmor|.github/workflows/old.yml|obfuscation|gone"]
        code, _, _ = self.check("zizmor", 14, [INJECTION], base, summary=summary, plain=plain)
        with open(summary, encoding="utf-8") as handle:
            text = handle.read()
        self.assertEqual(code, 1)
        self.assertLess(text.index("new finding(s)"), text.index("stale baseline line(s)"))
        self.assertLess(text.index("stale baseline line(s)"), text.index("the full report"))
        self.assertIn("````", text)


class Generate(Case):
    def test_generate_writes_a_header_and_sorted_lines_that_then_pass_the_check(self):
        a = self.write("al.json", [al("b.yml", "shellcheck", "m2"), al("a.yml", "shellcheck", "m1")])
        z = self.write("zz.json", [INJECTION])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(wlb.main(["generate", "--actionlint", a, "--zizmor", z]), 0)
        text = out.getvalue()
        body = [line for line in text.splitlines() if line and not line.startswith("#")]
        self.assertEqual(body, sorted(body))
        self.assertTrue(text.startswith("# Workflow lint baseline"))
        base = self.write("base.txt", text)
        self.assertEqual(wlb.main(["check", "--tool", "actionlint", "--rc", "1", "--findings", a, "--baseline", base]), 0)
        self.assertEqual(wlb.main(["check", "--tool", "zizmor", "--rc", "14", "--findings", z, "--baseline", base]), 0)


if __name__ == "__main__":
    unittest.main()

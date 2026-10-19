import unittest

from pgraph.globs import GlobError, compile_glob, normalize_path


class GlobTests(unittest.TestCase):

    def test_double_star_is_anchored_at_root(self):
        g = compile_glob("tools/**")
        self.assertTrue(g.match("tools/x"))
        self.assertTrue(g.match("tools/a/b/c.py"))
        self.assertFalse(g.match("services/backend-core/tools/x"))
        self.assertFalse(g.match("tools"))

    def test_single_star_does_not_cross_slash(self):
        g = compile_glob("*")
        self.assertTrue(g.match("CODEOWNERS"))
        self.assertFalse(g.match("docs/a.md"))
        self.assertTrue(compile_glob("migrations/*cash*").match("migrations/0003_cash_up.sql"))
        self.assertFalse(compile_glob("migrations/*cash*").match("migrations/x/cash.sql"))

    def test_middle_double_star_matches_zero_or_more_dirs(self):
        g = compile_glob("tests/**/test_contracts.py")
        self.assertTrue(g.match("tests/test_contracts.py"))
        self.assertTrue(g.match("tests/a/b/test_contracts.py"))
        self.assertFalse(g.match("tests/a/xtest_contracts.py"))

    def test_braces_expand(self):
        g = compile_glob("src/main/{payments,drawer}/**")
        self.assertTrue(g.match("src/main/payments/a.ts"))
        self.assertTrue(g.match("src/main/drawer/a.ts"))
        self.assertFalse(g.match("src/main/sales/a.ts"))

    def test_case_sensitive(self):
        self.assertFalse(compile_glob("apps/**").match("APPS/x"))

    def test_regex_metacharacters_are_literal(self):
        g = compile_glob("a+b.(c)")
        self.assertTrue(g.match("a+b.(c)"))
        self.assertFalse(g.match("aab.(c)"))
        self.assertFalse(g.match("a+bx(c)"))

    def test_invalid_double_star_segment_is_rejected(self):
        for bad in ("a/**x", "x**/a", "", "/abs", "a/../b", "a/{b"):
            with self.subTest(bad=bad):
                with self.assertRaises(GlobError):
                    compile_glob(bad)

    def test_normalize_path_nfc(self):
        self.assertEqual(normalize_path("café.md"), "café.md")
        self.assertEqual(normalize_path("./a/b"), "a/b")


if __name__ == "__main__":
    unittest.main()

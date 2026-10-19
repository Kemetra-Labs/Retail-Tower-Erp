"""Anchored gitignore-style globs (RT-709 A.1 glob dialect).

`*` and `?` never cross `/`; a `**` segment spans zero or more directories (or,
as the last segment, everything below); `{a,b}` expands. Matching is
case-sensitive on NFC-normalised `/`-separated repo paths. Leading `/`, `..`
segments, empty segments and partial `**` (e.g. `a**`) are rejected."""

import re
import unicodedata


MAX_GLOB_LENGTH = 256
MAX_EXPANSIONS = 64
MAX_DOUBLE_STAR = 3


class GlobError(ValueError):
    pass


def normalize_path(path):
    path = unicodedata.normalize("NFC", path)
    while path.startswith("./"):
        path = path[2:]
    return path


def _expand_braces(glob):
    start = glob.find("{")
    if start == -1:
        if "}" in glob:
            raise GlobError(f"unbalanced brace: {glob}")
        return [glob]
    end = glob.find("}", start)
    if end == -1:
        raise GlobError(f"unbalanced brace: {glob}")
    head, body, tail = glob[:start], glob[start + 1:end], glob[end + 1:]
    out = []
    for option in body.split(","):
        out.extend(_expand_braces(head + option + tail))
    return out


def _segment_regex(seg):
    out = []
    for ch in seg:
        if ch == "*":
            out.append("[^/]*")
        elif ch == "?":
            out.append("[^/]")
        else:
            out.append(re.escape(ch))
    return "".join(out)


def _translate(glob):
    if not glob or glob.startswith("/"):
        raise GlobError(f"empty or absolute glob: {glob!r}")
    segs = glob.split("/")
    parts = []
    for i, seg in enumerate(segs):
        last = i == len(segs) - 1
        if seg in ("", ".", ".."):
            raise GlobError(f"bad segment in glob: {glob!r}")
        if seg == "**":
            parts.append(".+" if last else "(?:[^/]+/)*")
            continue
        if "**" in seg:
            raise GlobError(f"'**' must be a whole segment: {glob!r}")
        parts.append(_segment_regex(seg) + ("" if last else "/"))
    return "".join(parts)


class Glob:
    __slots__ = ("text", "_regex")

    def __init__(self, text):
        # Caps keep an untrusted proposed graph from causing exponential brace
        # expansion or catastrophic regex backtracking (review finding).
        if len(text) > MAX_GLOB_LENGTH:
            raise GlobError(f"glob longer than {MAX_GLOB_LENGTH}: {text[:40]!r}...")
        if text.count("{") > 6:
            raise GlobError(f"too many brace groups: {text!r}")
        expanded = _expand_braces(text)
        if len(expanded) > MAX_EXPANSIONS:
            raise GlobError(f"brace expansion exceeds {MAX_EXPANSIONS}: {text!r}")
        if any(g.split("/").count("**") > MAX_DOUBLE_STAR for g in expanded):
            raise GlobError(f"more than {MAX_DOUBLE_STAR} '**' segments: {text!r}")
        self.text = text
        alternatives = [_translate(g) for g in expanded]
        self._regex = re.compile("(?:" + "|".join(alternatives) + ")", re.DOTALL)

    def match(self, path):
        return self._regex.fullmatch(path) is not None

    def literal_prefix(self):
        """Longest leading run of whole literal segments, for static checks."""
        out = []
        for seg in self.text.split("/"):
            if any(c in seg for c in "*?{}"):
                break
            out.append(seg)
        return "/".join(out)


def compile_glob(text):
    if not isinstance(text, str):
        raise GlobError(f"glob must be a string: {text!r}")
    return Glob(text)

#!/usr/bin/env python3
"""Make a coverage report importable by the SonarQube Cloud scanner (RT-901). Stdlib only.

  sonar_coverage_prep.py lcov      REPORT OUT --base DIR [--prefix P]
  sonar_coverage_prep.py cobertura REPORT OUT --base DIR [--source-subdir S]
                                     exit 0 every file resolved, 1 a problem, 2 unreadable input

The scanner resolves each coverage path against the project base directory, and a path it cannot
resolve is dropped with only a warning, so the import "succeeds" with no coverage. This rewrites
every path to one relative to --base and fails when any file is missing there, or when the report
holds no files at all, so a path mismatch fails the job instead of posting an analysis without
coverage.

  lcov       `SF:` paths are relative to the directory the test runner ran in. --prefix is that
             directory's path under --base (Jest in apps/api: `apps/api/`); an absolute path is
             accepted only when it lies under --base.
  cobertura  `filename` is relative to a `<source>` directory. Each is tried as given and under
             --source-subdir (pytest-cov --cov=PKG writes it relative to PKG), then the `<sources>`
             block is dropped.

Prints the file count and the line totals of the rewritten report, which is the evidence that the
expected report was read.
"""
import argparse
import os
import sys
import xml.etree.ElementTree as ET


def _exists(base, rel):
    return os.path.isfile(os.path.join(base, rel))


def _lcov_rel(base, raw, prefix):
    raw = raw.strip().replace("\\", "/")
    if os.path.isabs(raw):
        rel = os.path.relpath(raw, base).replace(os.sep, "/")
        return rel if not rel.startswith("..") and _exists(base, rel) else None
    rel = os.path.normpath(prefix + raw).replace(os.sep, "/")
    return rel if _exists(base, rel) else None


def prep_lcov(report, out, base, prefix=""):
    rewritten, missing, files, found, hit = [], [], 0, 0, 0
    with open(report, encoding="utf-8") as fh:
        for line in fh.read().splitlines():
            if line.startswith("SF:"):
                rel = _lcov_rel(base, line[3:], prefix)
                if rel is None:
                    missing.append(line[3:])
                else:
                    files += 1
                    line = "SF:" + rel
            elif line.startswith("LF:"):
                found += int(line[3:])
            elif line.startswith("LH:"):
                hit += int(line[3:])
            rewritten.append(line)
    with open(out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(rewritten) + "\n")
    return files, missing, found, hit


def _cobertura_rel(base, filename, subdir):
    filename = filename.strip().replace("\\", "/")
    for rel in (filename, f"{subdir}/{filename}" if subdir else None):
        if rel and _exists(base, rel):
            return os.path.normpath(rel).replace(os.sep, "/")
    return None


def prep_cobertura(report, out, base, subdir=""):
    tree = ET.parse(report)
    root = tree.getroot()
    files, missing, seen = 0, [], set()
    for cls in root.iter("class"):
        raw = cls.get("filename", "")
        rel = _cobertura_rel(base, raw, subdir)
        if rel is None:
            missing.append(raw)
            continue
        cls.set("filename", rel)
        if rel not in seen:
            seen.add(rel)
            files += 1
    for sources in root.findall("sources"):
        root.remove(sources)
    tree.write(out, encoding="utf-8", xml_declaration=True)
    found = int(root.get("lines-valid", 0) or 0)
    hit = int(root.get("lines-covered", 0) or 0)
    return files, missing, found, hit


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("kind", choices=("lcov", "cobertura"))
    ap.add_argument("report")
    ap.add_argument("out")
    ap.add_argument("--base", required=True)
    ap.add_argument("--prefix", default="")
    ap.add_argument("--source-subdir", default="")
    args = ap.parse_args(argv)
    try:
        if args.kind == "lcov":
            result = prep_lcov(args.report, args.out, args.base, args.prefix)
        else:
            result = prep_cobertura(args.report, args.out, args.base, args.source_subdir)
    except (OSError, ET.ParseError, ValueError) as exc:
        print(f"::error::cannot read {args.report}: {exc}", file=sys.stderr)
        return 2
    files, missing, found, hit = result
    pct = f"{100 * hit / found:.1f}%" if found else "n/a"
    print(f"{args.kind}: {files} files resolved under {args.base}, {hit}/{found} lines hit ({pct})")
    if missing:
        print(f"::error::{len(missing)} coverage path(s) do not resolve under {args.base}", file=sys.stderr)
        for raw in missing[:20]:
            print(f"  unresolved: {raw}", file=sys.stderr)
        return 1
    if files == 0:
        print("::error::the coverage report lists no files", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())

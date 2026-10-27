"""Offline tests for publish.py: tiny temp repos, no network, no git config touched."""
import os
import subprocess
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import publish  # noqa: E402

REPO = "Kemetra/Retail-Tower-Shadow"
SUB = publish.SUBDIR
ENV = {**os.environ, "GIT_AUTHOR_NAME": "Dev", "GIT_AUTHOR_EMAIL": "dev@example.invalid",
       "GIT_COMMITTER_NAME": "Dev", "GIT_COMMITTER_EMAIL": "dev@example.invalid",
       "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def g(cwd, *args, env=None):
    r = subprocess.run(["git", *args], cwd=cwd, env={**ENV, **(env or {})}, capture_output=True, text=True, check=True)
    return r.stdout.strip()


def commit(src, files, msg, date="2026-01-01T00:00:00Z"):
    for rel, text in files.items():
        p = Path(src, rel)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    g(src, "add", "-A")
    g(src, "commit", "-q", "-m", msg, env={"GIT_AUTHOR_DATE": date, "GIT_COMMITTER_DATE": date})
    return g(src, "rev-parse", "HEAD")


@pytest.fixture
def world(tmp_path):
    src = tmp_path / "src"
    src.mkdir()
    g(src, "init", "-q", "-b", "main")
    base = commit(src, {f"{SUB}/pyproject.toml": "v0", f"{SUB}/app/hooks.py": "h0", "apps/pos/x": "x"}, "base")
    mirror = tmp_path / "mirror.git"
    g(tmp_path, "init", "-q", "--bare", "-b", "main", str(mirror))
    seed = g(src, "commit-tree", g(src, "rev-parse", f"{base}:{SUB}"), "-m", "frozen live main")
    g(src, "push", "-q", str(mirror), f"{seed}:refs/heads/main")
    return src, mirror, base, seed


def run(src, mirror, base=None, **kw):
    return publish.publish(str(mirror), REPO, str(src), base=base, **kw)


def test_publish_layout_trailers_tree_equality_and_chain(world):
    src, mirror, base, seed = world
    c1 = commit(src, {f"{SUB}/pyproject.toml": "v1"}, "feat: one (#7)")
    commit(src, {"apps/pos/x": "y"}, "pos only")  # does not touch the connector: not mirrored
    c3 = commit(src, {f"{SUB}/app/new.py": "n"}, "feat: two")
    plan = run(src, mirror, base)
    assert [s for s, _ in plan.commits] == [c1, c3]
    assert g(mirror, "rev-parse", "main") == plan.tip
    assert g(mirror, "ls-tree", "--name-only", "main").split() == ["app", "pyproject.toml"]
    assert g(mirror, "merge-base", "--is-ancestor", seed, "main") == ""
    for s, m in plan.commits:
        assert g(mirror, "rev-parse", f"{m}^{{tree}}") == g(src, "rev-parse", f"{s}:{SUB}")
        body = g(mirror, "log", "-1", "--format=%B", m)
        assert f"Monorepo-Commit: {REPO}@{s}" in body.splitlines()
    assert f"{REPO}#7" in g(mirror, "log", "-1", "--format=%s", plan.commits[0][1])
    assert g(mirror, "rev-list", "--count", "main") == "3"  # seed + 2


def test_rerun_is_noop_and_republish_is_identical(world):
    src, mirror, base, _ = world
    commit(src, {f"{SUB}/pyproject.toml": "v1"}, "one")
    first = run(src, mirror, base)
    again = run(src, mirror, base)
    assert not again.commits and g(mirror, "rev-parse", "main") == first.tip
    # a second, independent mirror gets the very same commit SHA (deterministic)
    other = src.parent / "other.git"
    g(src.parent, "init", "-q", "--bare", "-b", "main", str(other))
    g(mirror, "push", "-q", str(other), "main~1:refs/heads/main")
    assert run(src, other, base).tip == first.tip


def test_older_source_head_is_noop(world):
    src, mirror, base, _ = world
    c1 = commit(src, {f"{SUB}/pyproject.toml": "v1"}, "one")
    commit(src, {f"{SUB}/pyproject.toml": "v2"}, "two")
    run(src, mirror, base)
    before = g(mirror, "rev-parse", "main")
    assert not run(src, mirror, source_ref=c1).commits
    assert g(mirror, "rev-parse", "main") == before


def test_bootstrap_requires_matching_base(world):
    src, mirror, base, _ = world
    c1 = commit(src, {f"{SUB}/pyproject.toml": "v1"}, "one")
    with pytest.raises(publish.Refusal, match="--base"):
        run(src, mirror)
    with pytest.raises(publish.Refusal, match="frozen baseline"):
        run(src, mirror, c1)


def test_human_commit_on_mirror_is_refused(world):
    src, mirror, base, _ = world
    commit(src, {f"{SUB}/pyproject.toml": "v1"}, "one")
    run(src, mirror, base)
    head = g(mirror, "rev-parse", "main")
    human = g(mirror, "commit-tree", g(mirror, "rev-parse", "main^{tree}"), "-p", head, "-m", "hotfix by hand")
    g(mirror, "update-ref", "refs/heads/main", human)
    commit(src, {f"{SUB}/pyproject.toml": "v2"}, "two")
    with pytest.raises(publish.Refusal):
        run(src, mirror, base)
    assert g(mirror, "rev-parse", "main") == human


def test_regenerated_source_history_is_refused(world, tmp_path):
    src, mirror, base, _ = world
    commit(src, {f"{SUB}/pyproject.toml": "v1"}, "one")
    run(src, mirror, base)
    rewritten = tmp_path / "rewritten"
    rewritten.mkdir()
    g(rewritten, "init", "-q", "-b", "main")
    commit(rewritten, {f"{SUB}/pyproject.toml": "v0"}, "base")
    commit(rewritten, {f"{SUB}/pyproject.toml": "v1"}, "one")
    commit(rewritten, {f"{SUB}/pyproject.toml": "v2"}, "two")
    with pytest.raises(publish.Refusal, match="not resolvable"):
        run(rewritten, mirror)


def test_remote_moved_between_fetch_and_push_is_rejected_then_recovers(world):
    src, mirror, base, _ = world
    commit(src, {f"{SUB}/pyproject.toml": "v1"}, "one")

    def sneak():  # another writer lands a commit after our fetch
        head = g(mirror, "rev-parse", "main")
        g(mirror, "update-ref", "refs/heads/main",
          g(mirror, "commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-p", head, "-m", "other writer"))

    with pytest.raises(publish.PushRejected):
        run(src, mirror, base, before_push=sneak)
    assert g(mirror, "log", "-1", "--format=%s", "main") == "other writer"  # never overwritten
    with pytest.raises(publish.Refusal, match="frozen baseline"):  # reconcile will not build on a foreign head
        run(src, mirror, base)


def test_concurrent_publishers_converge_on_one_linear_history(world):
    src, mirror, base, _ = world
    for i in range(3):
        commit(src, {f"{SUB}/pyproject.toml": f"v{i + 1}"}, f"c{i}")
    errors = []

    def go():
        try:
            run(src, mirror, base)
        except (publish.PushRejected, publish.Refusal) as exc:  # the loser may be rejected; never diverge
            errors.append(exc)

    threads = [threading.Thread(target=go) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert g(mirror, "rev-list", "--count", "main") == "4"
    assert g(mirror, "rev-list", "--merges", "--count", "main") == "0"
    assert not run(src, mirror).commits  # a re-run settles to a no-op


def test_crash_after_push_then_rerun_is_noop_and_crash_before_push_recovers(world):
    src, mirror, base, _ = world
    commit(src, {f"{SUB}/pyproject.toml": "v1"}, "one")

    class Boom(Exception):
        pass

    def die():
        raise Boom

    with pytest.raises(Boom):
        run(src, mirror, base, before_push=die)
    assert g(mirror, "rev-list", "--count", "main") == "1"  # nothing landed
    assert len(run(src, mirror, base).commits) == 1
    assert not run(src, mirror, base).commits


def test_tags_map_and_are_immutable(world):
    src, mirror, base, _ = world
    c1 = commit(src, {f"{SUB}/pyproject.toml": "v1"}, "one")
    g(src, "tag", f"{publish.TAG_PREFIX}v1.0.0", c1)
    g(src, "tag", f"{publish.TAG_PREFIX}not-semver", c1)
    plan = run(src, mirror, base)
    assert [t for t, _ in plan.tags] == ["v1.0.0"]
    assert g(mirror, "rev-parse", "v1.0.0") == plan.commits[0][1]
    c2 = commit(src, {f"{SUB}/pyproject.toml": "v2"}, "two")
    g(src, "tag", "-f", f"{publish.TAG_PREFIX}v1.0.0", c2)  # someone moves the source tag
    with pytest.raises(publish.Refusal, match="immutable"):
        run(src, mirror, base)
    assert g(mirror, "rev-parse", "v1.0.0") == plan.commits[0][1]


def test_no_tags_publishes_commits_only_and_a_later_run_still_maps_the_tag(world):
    src, mirror, base, _ = world
    c1 = commit(src, {f"{SUB}/pyproject.toml": "v1"}, "one")
    g(src, "tag", f"{publish.TAG_PREFIX}v1.0.0", c1)
    plan = run(src, mirror, base, tags=False)  # the main-branch sync: a release tag must not ride along
    assert [s for s, _ in plan.commits] == [c1] and not plan.tags
    assert g(mirror, "tag", "-l") == ""
    plan = run(src, mirror, base)  # the gated release path publishes it
    assert not plan.commits and [t for t, _ in plan.tags] == ["v1.0.0"]
    assert g(mirror, "rev-parse", "v1.0.0") == g(mirror, "rev-parse", "main")
    # the CLI flag reaches publish(): a newer commit is mirrored, its newer tag is not
    c2 = commit(src, {f"{SUB}/pyproject.toml": "v2"}, "two")
    g(src, "tag", f"{publish.TAG_PREFIX}v2.0.0", c2)
    assert publish.main(["--mirror", str(mirror), "--source-repo", REPO, "--source-dir", str(src), "--no-tags"]) == 0
    assert g(mirror, "tag", "-l") == "v1.0.0"
    assert g(mirror, "log", "-1", "--format=%s", "main") == "two"


def test_verify_detects_tampered_tree(world):
    src, mirror, base, _ = world
    commit(src, {f"{SUB}/pyproject.toml": "v1"}, "one")
    run(src, mirror, base)
    assert publish.main(["--mirror", str(mirror), "--source-repo", REPO, "--source-dir", str(src), "--verify"]) == 0
    head = g(mirror, "rev-parse", "main")
    msg = g(mirror, "log", "-1", "--format=%B", head)
    empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"  # the empty tree
    forged = subprocess.run(["git", "commit-tree", empty, "-p", g(mirror, "rev-parse", "main~1"), "-F", "-"], cwd=mirror,
                            env=ENV, input=msg, capture_output=True, text=True, check=True).stdout.strip()
    g(mirror, "update-ref", "refs/heads/main", forged)
    assert publish.main(["--mirror", str(mirror), "--source-repo", REPO, "--source-dir", str(src), "--verify"]) == 2


def test_tag_added_after_commit_is_published_on_a_later_noop_run(world):
    src, mirror, base, _ = world
    c1 = commit(src, {f"{SUB}/pyproject.toml": "v1"}, "one")
    run(src, mirror, base)  # commit published, no tag yet
    g(src, "tag", f"{publish.TAG_PREFIX}v1.0.0", c1)
    plan = run(src, mirror, base)  # source head == last published commit
    assert not plan.commits and [t for t, _ in plan.tags] == ["v1.0.0"]
    assert g(mirror, "rev-parse", "v1.0.0") == g(mirror, "rev-parse", "main")
    c2 = commit(src, {f"{SUB}/pyproject.toml": "v2"}, "two")
    run(src, mirror, base)
    g(src, "tag", "-f", f"{publish.TAG_PREFIX}v1.0.0", c2)  # a moved source tag is still caught on a no-op run
    with pytest.raises(publish.Refusal, match="immutable"):
        run(src, mirror, base)


SHA_A, SHA_B = "a" * 40, "b" * 40


def test_provenance_in_reads_the_raw_message_not_git_trailer_parsing():
    line = f"Monorepo-Commit: {REPO}@{SHA_A}"
    assert publish.provenance_in(f"feat: x\n\n{line}\n") == (REPO, SHA_A)
    # the shape git's trailer parser loses: the trailer sits above a bare `---` line
    assert publish.provenance_in(f"feat: x\n\nbody\n\n{line}\n---\nmore\n") == (REPO, SHA_A)
    assert publish.provenance_in(f"feat: x\r\n\r\n{line}\r\n") == (REPO, SHA_A)  # CR-tolerant
    assert publish.provenance_in(f"feat: x\n\nMonorepo-Commit: {REPO}@{SHA_B}\n\nbody\n{line}  \n") == (REPO, SHA_A)
    twice = f"feat: x\n\nMonorepo-Commit: {REPO}@{SHA_A}\n\nMonorepo-Commit: {REPO}@{SHA_B}\n"
    assert publish.provenance_in(twice) == (REPO, SHA_B)  # last match wins
    for bad in (f"see {line} inline", f"Monorepo-Commit: {REPO}@{SHA_A[:39]}", f"Monorepo-Commit: {REPO}@{'A' * 40}",
                f"Monorepo-Commit: nodash@{SHA_A}", f" {line}", "feat: x\n"):
        assert publish.provenance_in(bad) is None


def test_separator_line_message_does_not_stall_the_next_run(world):
    src, mirror, base, _ = world
    c1 = commit(src, {f"{SUB}/pyproject.toml": "v1"}, "feat: one\n\nbody\n---\nmore text")
    first = run(src, mirror, base)
    # write side is unchanged: interpret-trailers puts the trailer ABOVE a bare `---` line...
    assert g(mirror, "log", "-1", "--format=%B", first.tip).splitlines() == [
        "feat: one", "", "body", "", f"Monorepo-Commit: {REPO}@{c1}", "---", "more text"]
    # ...where git's own trailer parser no longer sees it
    assert g(mirror, "log", "-1", "--format=%(trailers:key=Monorepo-Commit)", first.tip) == ""
    c2 = commit(src, {f"{SUB}/pyproject.toml": "v2"}, "feat: two")
    plan = run(src, mirror)  # no --base: provenance must come from the mirror itself
    assert [s for s, _ in plan.commits] == [c2]
    assert g(mirror, "rev-parse", "main") == plan.tip and not run(src, mirror).commits


def test_mirror_map_and_verify_see_a_separator_line_commit(world, capsys):
    src, mirror, base, _ = world
    c1 = commit(src, {f"{SUB}/pyproject.toml": "v1"}, "feat: one\n\nbody\n---\nmore text")
    tip = run(src, mirror, base).tip
    assert publish.mirror_map(str(mirror), "main") == {c1: tip}
    cli = ["--mirror", str(mirror), "--source-repo", REPO, "--source-dir", str(src), "--verify"]
    capsys.readouterr()
    assert publish.main(cli) == 0
    assert "1 published commit(s) verified" in capsys.readouterr().out
    msg = g(mirror, "log", "-1", "--format=%B", tip)  # a forged tree under the same message must not slip past --verify
    empty = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    forged = subprocess.run(["git", "commit-tree", empty, "-p", g(mirror, "rev-parse", "main~1"), "-F", "-"], cwd=mirror,
                            env=ENV, input=msg, capture_output=True, text=True, check=True).stdout.strip()
    g(mirror, "update-ref", "refs/heads/main", forged)
    assert publish.main(cli) == 2


def test_message_without_a_separator_line_is_unchanged(world):
    src, mirror, base, _ = world
    c1 = commit(src, {f"{SUB}/pyproject.toml": "v1"}, "feat: one (#7)\n\nbody\n\nCo-Authored-By: A <a@example.invalid>")
    c2 = commit(src, {f"{SUB}/pyproject.toml": "v2"}, "feat: two\n\n---------\n\nsquash separator is not a patch separator")
    plan = run(src, mirror, base)
    (_, m1), (_, m2) = plan.commits
    assert g(mirror, "log", "-1", "--format=%B", m1) == (
        f"feat: one ({REPO}#7)\n\nbody\n\nCo-Authored-By: A <a@example.invalid>\nMonorepo-Commit: {REPO}@{c1}")
    assert g(mirror, "log", "-1", "--format=%B", m2).splitlines()[-1] == f"Monorepo-Commit: {REPO}@{c2}"
    assert g(mirror, "log", "-1", "--format=%(trailers:key=Monorepo-Commit,valueonly)", m2) == f"{REPO}@{c2}"
    assert not run(src, mirror).commits  # and the next run still anchors on the mirror alone


def test_text_after_a_separator_line_cannot_override_the_real_trailer(world):
    src, mirror, base, _ = world
    forged = f"Monorepo-Commit: {REPO}@{SHA_B}"
    assert publish.provenance_in(f"s\n\nMonorepo-Commit: {REPO}@{SHA_A}\n---\n{forged}\n") == (REPO, SHA_A)
    assert publish.provenance_in(f"s\n\n{forged}\n---------\nsquash text is not a separator\n") == (REPO, SHA_B)
    c1 = commit(src, {f"{SUB}/pyproject.toml": "v1"}, f"feat: one\n\nbody\n---\n{forged}")
    tip = run(src, mirror, base).tip
    assert publish.published(str(mirror), "main") == {tip: (REPO, c1)}


def test_control_characters_in_a_message_cannot_forge_a_log_record(world):
    _, mirror, _, _ = world
    real, fake = "e" * 40, "d" * 40
    msg = f"s\n\nMonorepo-Commit: {REPO}@{real}\n\x1e{'f' * 40}\x1fMonorepo-Commit: {REPO}@{fake}\n\x1e stray\n"
    head = subprocess.run(["git", "commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-p", g(mirror, "rev-parse", "main"),
                           "-F", "-"], cwd=mirror, env=ENV, input=msg.encode(), capture_output=True, check=True).stdout.decode().strip()
    g(mirror, "update-ref", "refs/heads/main", head)
    assert publish.published(str(mirror), "main") == {head: (REPO, real)}


def test_text_after_a_scissors_line_cannot_override_the_real_trailer(world):
    src, mirror, base, _ = world
    scissors = "# " + "-" * 24 + " >8 " + "-" * 24
    forged = f"Monorepo-Commit: {REPO}@{SHA_B}"
    assert publish.provenance_in(f"s\n\nMonorepo-Commit: {REPO}@{SHA_A}\n{scissors}\n{forged}\n") == (REPO, SHA_A)
    assert publish.provenance_in(f"s\n\n{forged}\n# {'-' * 23} >8 {'-' * 24}\nnot a scissors line\n") == (REPO, SHA_B)
    # `git commit -m` would strip the `#` line, so build the source commit with commit-tree
    msg = f"feat: one\n\nbody\n{scissors}\n{forged}\n"
    Path(src, SUB, "pyproject.toml").write_text("v1")
    g(src, "add", "-A")
    tree = g(src, "write-tree")
    c1 = subprocess.run(["git", "commit-tree", tree, "-p", "HEAD", "-F", "-"], cwd=src, env=ENV, input=msg, text=True,
                        capture_output=True, check=True).stdout.strip()
    g(src, "update-ref", "refs/heads/main", c1)
    tip = run(src, mirror, base).tip
    assert publish.published(str(mirror), "main") == {tip: (REPO, c1)}


def raw(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, env=ENV, capture_output=True, check=True).stdout


def test_git_helper_sends_stdin_without_newline_translation():
    # Text-mode stdin turns "\n" into "\r\n" on Windows. That changes every commit message and so every mirror SHA
    # (CI runs on Linux), so the same text must hash to the same blob on every host.
    assert publish.git("hash-object", "--stdin", stdin="a\n") == "78981922613b2afb6025042ff6bd878ac1994e85"


def test_published_commit_message_has_no_carriage_returns(world):
    src, mirror, base, _ = world
    commit(src, {f"{SUB}/pyproject.toml": "v1"}, "feat: one (#7)")
    plan = run(src, mirror, base)
    obj = raw(mirror, "cat-file", "commit", plan.tip)
    assert b"\r" not in obj
    assert obj.endswith(f"Monorepo-Commit: {REPO}@{plan.commits[0][0]}\n".encode())


def test_non_utf8_byte_in_a_mirror_message_does_not_abort_the_provenance_read(world, capsys):
    src, mirror, base, _ = world
    c1 = commit(src, {f"{SUB}/pyproject.toml": "v1"}, "feat: one")
    tip = run(src, mirror, base).tip
    msg = f"s\n\nMonorepo-Commit: {REPO}@{c1}\n".encode() + b"caf\xe9 (latin-1)\n"
    # commit-tree would re-encode the message to UTF-8, so write the raw commit object
    who = b"Dev <dev@example.invalid> 1767225600 +0000"
    raw_commit = (f"tree {g(mirror, 'rev-parse', 'main^{tree}')}\nparent {tip}\n".encode()
                  + b"author " + who + b"\ncommitter " + who + b"\n\n" + msg)
    head = subprocess.run(["git", "hash-object", "-t", "commit", "-w", "--stdin", "--literally"], cwd=mirror, env=ENV,
                          input=raw_commit, capture_output=True, check=True).stdout.decode().strip()
    g(mirror, "update-ref", "refs/heads/main", head)
    assert publish.last_provenance(str(mirror), "main", REPO) == c1
    assert publish.published(str(mirror), "main")[head] == (REPO, c1)
    capsys.readouterr()
    cli = ["--mirror", str(mirror), "--source-repo", REPO, "--source-dir", str(src), "--verify"]
    assert publish.main(cli) == 0

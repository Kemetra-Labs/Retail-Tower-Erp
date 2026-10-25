"""`python -m contracts_check --repo <root> --oasdiff <binary> [--summary <file>]`

Runs every check in config.yaml against the working tree at <root>, prints a text report and,
with --summary, appends a Markdown report (the GitHub job summary). Exit 1 when any check
fails, 2 when the configuration itself is unusable."""

import argparse
import pathlib
import sys

import yaml

from . import connector, identical, pins
from .findings import failed, markdown_report, text_report

DEFAULT_CONFIG = pathlib.Path(__file__).resolve().parents[1] / "config.yaml"
CHECKS = ("pins", "connector", "identical")


class ConfigError(ValueError):
    pass


def load_config(path):
    try:
        data = yaml.safe_load(pathlib.Path(path).read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError) as exc:
        raise ConfigError(f"cannot read {path}: {exc}") from None
    if not isinstance(data, dict):
        raise ConfigError("config is not a mapping")
    for key in ("contracts_root", "consumers", "connector", "identical"):
        if key not in data:
            raise ConfigError(f"config has no {key!r}")
    for key in ("consumers", "connector", "identical"):
        if not isinstance(data[key], list) or not data[key]:
            raise ConfigError(f"config {key!r} must be a non-empty list")
    return data


def run(repo, config, oasdiff, only=CHECKS):
    findings = []
    root = config["contracts_root"]
    if "pins" in only:
        severity = config.get("severity_levels")
        severity = pathlib.Path(repo) / severity if severity else None
        if severity is not None and not severity.is_file():
            raise ConfigError(f"severity_levels file {config['severity_levels']} is missing")
        for consumer in config["consumers"]:
            findings += pins.check_consumer(repo, consumer, root, oasdiff, severity)
    if "connector" in only:
        for entry in config["connector"]:
            findings += connector.check_module(repo, entry, root)
    if "identical" in only:
        for group in config["identical"]:
            findings += identical.check_group(repo, group)
    return findings


def main(argv=None):
    parser = argparse.ArgumentParser(prog="contracts_check", description=__doc__.splitlines()[0])
    parser.add_argument("--repo", required=True, help="repository root (working tree to check)")
    parser.add_argument("--oasdiff", default="oasdiff", help="oasdiff binary (needed for the pins check)")
    parser.add_argument("--config", default=str(DEFAULT_CONFIG))
    parser.add_argument("--summary", help="append the Markdown report to this file")
    parser.add_argument("--only", action="append", choices=CHECKS, help="run only these checks")
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        findings = run(args.repo, config, args.oasdiff, tuple(args.only or CHECKS))
    except ConfigError as exc:
        sys.stderr.write(f"contracts/check: configuration error: {exc}\n")
        return 2
    sys.stdout.write(text_report(findings))
    if args.summary:
        with open(args.summary, "a", encoding="utf-8") as fh:
            fh.write(markdown_report(findings))
    return 1 if failed(findings) else 0

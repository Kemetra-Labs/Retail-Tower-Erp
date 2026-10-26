"""kemetra-agent token broker (RT-721 Substep B, step B6).

Runs in the OWNER's shell. It reads the App private key from 1Password
(`op read`; the unlock prompt is the owner's approval), mints a 1-hour
installation token scoped to the private Shadow only, checks the grant is no
broader than requested, starts the given command with ONLY that token, and
revokes the token when the command exits. The key is never written to disk,
passed to the child, or printed; the token is never printed.

Design: tools/ci-gate/AGENT-BROKER.md. This file is in the `policy` class.

Two profiles share this code (RT-870 added `reviewer`):
  agent     kemetra-agent[bot], the AUTHOR identity (Shadow, contents:write).
  reviewer  kemetra-reviewer[bot], the independent REVIEWER identity on the canonical repo.
            Its App has only pull_requests:write + metadata:read, so its token cannot push code.
The reviewer key must only ever be read in a shell that does not author PRs.

Usage:
  python broker.py --check                        # mint, verify, revoke; print non-secret summary
  python broker.py -- claude                      # run a session as kemetra-agent[bot]
  python broker.py --profile reviewer --check     # same dry run for the reviewer App
  python broker.py --profile reviewer -- claude   # a separate REVIEW session as kemetra-reviewer[bot]
  python broker.py --op-ref "op://tower/kemetra agent bot/credential" -- claude
"""

import argparse
import base64
import dataclasses
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

API = "https://api.github.com"


@dataclasses.dataclass(frozen=True)
class Profile:
    """One GitHub App identity: what it may be granted, where, and who it commits as."""
    name: str
    app_id: int
    installation_id: int
    repo_id: int
    repo_name: str
    permissions: dict
    op_ref: str
    bot_name: str
    bot_email: str


AGENT = Profile(
    name="agent", app_id=5373224, installation_id=173158171, repo_id=1425468661,
    repo_name="Kemetra/Retail-Tower-Shadow",
    permissions={"contents": "write", "pull_requests": "write", "issues": "read",
                 "checks": "read", "actions": "read", "metadata": "read"},
    op_ref="op://tower/kemetra agent bot/credential",
    bot_name="kemetra-agent[bot]", bot_email="344537132+kemetra-agent[bot]@users.noreply.github.com")
# RT-870: the independent reviewer. No contents permission, so its token cannot push, merge or
# edit files. It can read PRs (metadata) and submit reviews (pull_requests:write).
REVIEWER = Profile(
    name="reviewer", app_id=5485955, installation_id=175598150, repo_id=1430288487,
    repo_name="Kemetra-Labs/Retail-Tower-Erp",
    permissions={"pull_requests": "write", "metadata": "read"},
    op_ref="op://tower/kemetra-reviewer/credential",
    bot_name="kemetra-reviewer[bot]", bot_email="348508063+kemetra-reviewer[bot]@users.noreply.github.com")
PROFILES = {AGENT.name: AGENT, REVIEWER.name: REVIEWER}

# Module-level names kept for the agent profile (existing callers and tests).
APP_ID = AGENT.app_id
INSTALLATION_ID = AGENT.installation_id
REPO_ID = AGENT.repo_id
DEFAULT_OP_REF = AGENT.op_ref
PERMISSIONS = AGENT.permissions
BOT_NAME = AGENT.bot_name
BOT_EMAIL = AGENT.bot_email
OWNER_CREDENTIAL_VARS = ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN",
                         "GIT_ASKPASS", "SSH_ASKPASS", "GH_CONFIG_DIR", "SSH_AUTH_SOCK", "SSH_AGENT_PID",
                         "GIT_SSH", "GIT_SSH_COMMAND")
# SSH would use the owner's keys / agent, so it is disabled; GitHub SSH URLs are rewritten to HTTPS.
NO_SSH = 'echo "broker: SSH is disabled in agent sessions; use HTTPS" >&2; exit 1'
LEVEL = {"read": 1, "write": 2, "admin": 3}
# Reads the token from the environment at call time, so it never lands in git config.
CREDENTIAL_HELPER = '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f'


class BrokerError(RuntimeError):
    """Messages never contain key material, tokens or HTTP bodies."""


def _b64url(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def build_jwt(key_pem, app_id, now):
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    try:
        key = serialization.load_pem_private_key(key_pem, password=None)
    except (ValueError, TypeError):
        raise BrokerError("private key is not a valid unencrypted PEM") from None
    header = _b64url(json.dumps({"alg": "RS256", "typ": "JWT"}, separators=(",", ":")).encode())
    claims = {"iss": app_id, "iat": now - 60, "exp": now + 540}
    payload = _b64url(json.dumps(claims, separators=(",", ":")).encode())
    signing_input = f"{header}.{payload}".encode()
    signature = key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    return f"{header}.{payload}.{_b64url(signature)}"


def _headers(bearer):
    return {"Authorization": f"Bearer {bearer}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "kemetra-agent-broker"}


def mint_installation_token(jwt, http, profile=AGENT):
    body = json.dumps({"repository_ids": [profile.repo_id], "permissions": profile.permissions})
    status, data = http("POST", f"{API}/app/installations/{profile.installation_id}/access_tokens",
                        _headers(jwt), body)
    if status != 201 or not isinstance(data, dict):
        raise BrokerError(f"token request failed with HTTP {status}")
    return data


def check_grant(grant, profile=AGENT):
    token = grant.get("token")
    if not isinstance(token, str) or not token.startswith("ghs_"):
        raise BrokerError("response has no installation token")
    if not grant.get("expires_at"):
        raise BrokerError("response has no expiry")
    if grant.get("repository_selection") != "selected":
        raise BrokerError("token is not limited to selected repositories")
    repo_ids = [r.get("id") for r in grant.get("repositories") or []]
    if repo_ids != [profile.repo_id]:
        raise BrokerError(f"token repositories are {repo_ids}, expected only {profile.repo_id}")
    for name, level in (grant.get("permissions") or {}).items():
        wanted = profile.permissions.get(name)
        if wanted is None or LEVEL.get(level, 99) > LEVEL[wanted]:
            raise BrokerError(f"token grants {name}:{level}, more than requested")


def revoke(token, http):
    status, _ = http("DELETE", f"{API}/installation/token", _headers(token), None)
    return status == 204


def child_env(base_env, token, gh_config_dir, profile=AGENT):
    env = {k: v for k, v in base_env.items() if k not in OWNER_CREDENTIAL_VARS}
    pairs = [
        ("credential.helper", ""),                                   # drop GCM / gh / owner helpers
        ("credential.https://github.com.helper", CREDENTIAL_HELPER),  # bot token for github.com only
        ("url.https://github.com/.insteadOf", "git@github.com:"),
        ("url.https://github.com/.insteadOf", "ssh://git@github.com/"),
    ]
    env.update({
        "GH_TOKEN": token,
        "GH_CONFIG_DIR": gh_config_dir,
        "GIT_SSH_COMMAND": NO_SSH,
        "GIT_TERMINAL_PROMPT": "0",
        # Owner's global/system gitconfig are not read: a missing file is an empty config.
        "GIT_CONFIG_GLOBAL": os.path.join(gh_config_dir, "bot-gitconfig"),
        "GIT_CONFIG_NOSYSTEM": "1",
        "GCM_INTERACTIVE": "never",
        "GIT_AUTHOR_NAME": profile.bot_name, "GIT_COMMITTER_NAME": profile.bot_name,
        "GIT_AUTHOR_EMAIL": profile.bot_email, "GIT_COMMITTER_EMAIL": profile.bot_email,
        "GIT_CONFIG_COUNT": str(len(pairs)),
    })
    for i, (key, value) in enumerate(pairs):
        env[f"GIT_CONFIG_KEY_{i}"] = key
        env[f"GIT_CONFIG_VALUE_{i}"] = value
    return env


def _op_command(op_ref, account):
    """op://vault/item -> Document item (`op document get`);
    op://vault/item/[section/]field -> field (`op read`)."""
    if not op_ref.startswith("op://"):
        raise BrokerError("the key reference must be a 1Password op:// URI")
    parts = op_ref[len("op://"):].split("/")
    if len(parts) < 2 or any(not p for p in parts):
        raise BrokerError("the key reference must be op://vault/item or op://vault/item/field")
    acct = ["--account", account] if account else []
    if len(parts) == 2:
        vault, item = parts
        return ["op", "document", "get", item, "--vault", vault, *acct]
    return ["op", "read", *acct, op_ref]


def read_key(op_ref, run, account=None):
    out = run(_op_command(op_ref, account)).strip()
    if not out.startswith(b"-----BEGIN") or b"PRIVATE KEY-----" not in out:
        raise BrokerError("1Password value is not a PEM private key")
    return out


def _mint(op_ref, run, http, now, account=None, profile=AGENT):
    key = read_key(op_ref, run, account)
    try:
        jwt = build_jwt(key, profile.app_id, now)
    finally:
        del key
    return mint_installation_token(jwt, http, profile)


def _revoke_if_token(grant, http):
    token = grant.get("token")
    if not (isinstance(token, str) and token):
        return False
    if revoke(token, http):
        return True
    print(f"broker: WARNING token revocation failed; it stays valid until expires_at {grant.get('expires_at')}",
          file=sys.stderr)
    return False


def run_session(argv, op_ref, *, run, http, spawn, now, base_env, gh_config_dir, account=None, profile=AGENT):
    grant = _mint(op_ref, run, http, now, account, profile)
    try:
        check_grant(grant, profile)
        return spawn(argv, child_env(base_env, grant["token"], gh_config_dir, profile))
    finally:
        _revoke_if_token(grant, http)


def check_only(op_ref, *, run, http, now, account=None, profile=AGENT):
    grant = _mint(op_ref, run, http, now, account, profile)
    try:
        check_grant(grant, profile)
        summary = {"expires_at": grant["expires_at"],
                   "repositories": [r.get("full_name") for r in grant["repositories"]],
                   "permissions": grant["permissions"]}
    finally:
        revoked = _revoke_if_token(grant, http)
    return {**summary, "revoked": revoked}


# ----------------------------------------------------------- real adapters

def _run_op(cmd):
    proc = subprocess.run(cmd, capture_output=True, check=False)
    if proc.returncode != 0:
        # op's own first error line (e.g. "account is not signed in") never contains the secret;
        # stdout is never shown.
        first = (proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()[:1]
        reason = first[0][:200] if first else "no error text"
        raise BrokerError(f"`op {cmd[1]}` failed (exit {proc.returncode}): {reason}")
    return proc.stdout


def _http(method, url, headers, body):
    data = body.encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            status, raw = resp.status, resp.read()
    except urllib.error.HTTPError as err:
        status, raw = err.code, err.read()
    except (urllib.error.URLError, OSError):
        return 0, None          # network failure: callers treat any non-success status as failure
    try:
        return status, (json.loads(raw) if raw else None)
    except ValueError:
        return status, None


def _spawn(argv, env):
    exe = shutil.which(argv[0], path=env.get("PATH")) or argv[0]
    return subprocess.call([exe, *argv[1:]], env=env)


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    command = argv[argv.index("--") + 1:] if "--" in argv else []
    own = argv[:argv.index("--")] if "--" in argv else argv
    parser = argparse.ArgumentParser(prog="broker.py", description=__doc__.split("\n\n")[0])
    parser.add_argument("--profile", choices=sorted(PROFILES), default=AGENT.name,
                        help="which App identity to act as (default: agent)")
    parser.add_argument("--op-ref", default=None,
                        help="1Password op:// reference to the PEM (default: the profile's own)")
    parser.add_argument("--op-account", default=None,
                        help="1Password account (sign-in address or ID) holding the key, when several are configured")
    parser.add_argument("--check", action="store_true", help="mint, verify and revoke; print a non-secret summary")
    args = parser.parse_args(own)
    profile = PROFILES[args.profile]
    op_ref = args.op_ref or profile.op_ref
    if not args.check and not command:
        parser.error("give a command after `--`, e.g. `-- claude`, or use --check")
    try:
        if args.check:
            summary = check_only(op_ref, run=_run_op, http=_http, now=int(time.time()),
                                 account=args.op_account, profile=profile)
            print(json.dumps(summary, indent=2))
            return 0
        with tempfile.TemporaryDirectory(prefix=f"kemetra-{profile.name}-gh-") as gh_dir:
            return run_session(command, op_ref, run=_run_op, http=_http, spawn=_spawn,
                               now=int(time.time()), base_env=dict(os.environ), gh_config_dir=gh_dir,
                               account=args.op_account, profile=profile)
    except BrokerError as exc:
        print(f"broker: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())

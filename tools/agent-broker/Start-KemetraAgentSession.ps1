<#
.SYNOPSIS
  Start a session that acts as a Kemetra GitHub App bot (RT-721 B6; reviewer profile RT-870).

.DESCRIPTION
  Run this YOURSELF. broker.py reads the App private key from 1Password
  (you approve the unlock), mints a 1-hour token limited to one repository, starts the
  command with only that token, and revokes it when the command exits.
  The key never touches disk or the session; the token is never printed.
  Design: tools/ci-gate/AGENT-BROKER.md

  -Profile agent (default): kemetra-agent[bot], the AUTHOR identity (Shadow).
  -Profile reviewer: kemetra-reviewer[bot], the independent REVIEWER on Kemetra-Labs/Retail-Tower-Erp.
  Its App has only pull_requests:write + metadata:read, so it cannot push, merge or edit files.
  Start the reviewer in its OWN shell and session, never in the one that authors PRs.

.EXAMPLE
  .\tools\agent-broker\Start-KemetraAgentSession.ps1 -Check
  # mint, verify scope/permissions, revoke; prints only expiry, repo and permissions

.EXAMPLE
  .\tools\agent-broker\Start-KemetraAgentSession.ps1 -Profile reviewer -Check
  # same dry run for the reviewer App

.EXAMPLE
  .\tools\agent-broker\Start-KemetraAgentSession.ps1 -Profile reviewer
  # starts `claude` as kemetra-reviewer[bot]
#>
[CmdletBinding()]
param(
    [ValidateSet('agent', 'reviewer')]
    [string]$Profile = 'agent',
    # Empty means the profile's own default reference (broker.py).
    [string]$OpRef = '',
    # 1Password account holding the vault, when more than one is configured (sign-in address or ID).
    [string]$OpAccount = '',
    [switch]$Check,
    [string[]]$Command = @('claude')
)
$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $repo
$broker = Join-Path $PSScriptRoot 'broker.py'
$extraArgs = @('--profile', $Profile)
if ($OpRef) { $extraArgs += @('--op-ref', $OpRef) }
if ($OpAccount) { $extraArgs += @('--op-account', $OpAccount) }
if ($Check) {
    & python $broker @extraArgs --check
} else {
    & python $broker @extraArgs -- @Command
}
exit $LASTEXITCODE

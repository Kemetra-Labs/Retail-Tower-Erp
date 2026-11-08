<#
.SYNOPSIS
  RT-1294 - turn a prebuilt `win-unpacked` directory into the PILOT-signed per-user NSIS installer, verify
  it, and hand over exactly one file. For an EPHEMERAL GitHub Actions Windows runner only.

.DESCRIPTION
  Not for a developer machine: it adds one certificate to CurrentUser\My, trusts ONE public self-signed leaf
  in LocalMachine\Root (on this runner only, so Authenticode can validate the chain), and silently installs
  and uninstalls the app. `-Cleanup` removes every certificate it added (recorded in a state file under
  RUNNER_TEMP); the workflow runs it with `if: always()`. No device is ever asked to trust anything here.

  Modes
    release  signs with the pilot leaf from POS_PILOT_SIGN_PFX_BASE64 / POS_PILOT_SIGN_PFX_PASSWORD. The PFX
             must hold exactly one certificate, whose SHA-1 equals POS_PILOT_LEAF_SHA1, whose subject is
             exactly CN=Kemetra POS PILOT, that is self-signed, Code Signing only, not a CA and valid for
             at least 30 more days. The PFX bytes stay in memory and are never written to disk.
    dry-run  signs with an ephemeral self-signed pilot leaf (2 days) and reads no secret. It proves the build
             from the prepackaged app, the pilot hook, the timestamp, the signature checks and the silent
             install and uninstall. It does NOT exercise the release-only certificate path (in-memory PFX
             parse, pinned thumbprint): that path is first proven by the first real release.

  Steps: clear stray production signing variables -> certificate -> sign the prepackaged executable
  -> build the installer from the prepackaged app with the pilot config (never publishing, no update
  configuration anywhere) -> verify (signatures Valid, exact pilot subject, timestamped, no
  resources\app-update.yml before, in the installer's output or after the silent install, silent uninstall)
  -> copy the installer into -Out.

  Every verification failure is a hard failure (non-zero exit). Nothing secret is printed.

.PARAMETER Mode
  release or dry-run.
.PARAMETER Unpacked
  The `win-unpacked` directory built (and fused) by the earlier secret-free job.
.PARAMETER Version
  X.Y.Z. It must equal the version in package.json: the packaged app is not re-stamped here.
.PARAMETER Out
  Empty or absent directory that receives POS-Pulse-Setup-<Version>.exe.
.PARAMETER Cleanup
  Remove the certificates a previous run added, then exit.
#>
[CmdletBinding(DefaultParameterSetName = 'Release')]
param(
  [Parameter(ParameterSetName = 'Release', Mandatory = $true)][ValidateSet('release', 'dry-run')][string]$Mode,
  [Parameter(ParameterSetName = 'Release', Mandatory = $true)][string]$Unpacked,
  [Parameter(ParameterSetName = 'Release', Mandatory = $true)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
  [Parameter(ParameterSetName = 'Release', Mandatory = $true)][string]$Out,
  [Parameter(ParameterSetName = 'Cleanup', Mandatory = $true)][switch]$Cleanup
)

$ErrorActionPreference = 'Stop'
$leafSubject = 'CN=Kemetra POS PILOT'
# The publisher shown by Windows; compared case-sensitively against the signer's CN.
$signerCn = 'Kemetra POS PILOT'
$codeSigningOid = '1.3.6.1.5.5.7.3.3'

if (-not $env:RUNNER_TEMP) { throw 'RUNNER_TEMP is not set: this script is for an ephemeral GitHub runner only' }
$work = Join-Path $env:RUNNER_TEMP 'pilot-release'
$statePath = Join-Path $work 'state.json'
$stage = Join-Path $work 'out'
# The POS product root (apps/pos in the monorepo), not the git top level.
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path

$script:state = @{ userStore = @(); rootStore = @() }

# Records a thumbprint BEFORE it is added to a store, so -Cleanup covers a half-finished run too.
function Register-Thumbprint([string]$store, [string]$thumbprint) {
  $script:state[$store] = @($script:state[$store]) + $thumbprint
  $script:state | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $statePath
}

# -DeleteKey (user store only) also removes the persisted private key container. The LocalMachine\Root
# entry is public only, so it is removed without it; if the key removal fails the certificate still goes.
function Remove-PilotCertificate([string]$path, [switch]$DeleteKey) {
  # Only a full 40-hex thumbprint path: an empty value must never address the whole store.
  if ($path -notmatch '\\[0-9A-Fa-f]{40}$') { return }
  if (-not (Test-Path -LiteralPath $path)) { return }
  if ($DeleteKey) { Remove-Item -LiteralPath $path -DeleteKey -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
  # A removal that did not happen is a failure, never a silent success: the trusted entry or the key stays.
  if (Test-Path -LiteralPath $path) { throw "could not remove $path" }
}

function Remove-PilotTrust {
  Get-Process 'POS Pulse' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $statePath)) { return }
  $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  # Try every certificate, then fail if any removal failed.
  $failed = @()
  foreach ($t in @($saved.rootStore)) {
    try { Remove-PilotCertificate "Cert:\LocalMachine\Root\$t" } catch { $failed += $_.Exception.Message }
  }
  foreach ($t in @($saved.userStore)) {
    try { Remove-PilotCertificate "Cert:\CurrentUser\My\$t" -DeleteKey } catch { $failed += $_.Exception.Message }
  }
  if ($failed.Count -gt 0) { throw ("pilot certificate cleanup failed: " + ($failed -join '; ')) }
  Write-Host 'pilot certificates removed from LocalMachine\Root and CurrentUser\My'
}

if ($Cleanup) { Remove-PilotTrust; exit 0 }

# Trusts the PUBLIC leaf for Authenticode verification on this runner. A self-signed leaf is its own root.
# The object added is rebuilt from its public bytes, so no key material can come with it.
function Add-LeafTrust($leaf) {
  Register-Thumbprint 'rootStore' $leaf.Thumbprint
  $publicLeaf = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([byte[]]$leaf.RawData)
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
  try {
    $store.Open('ReadWrite')
    $store.Add($publicLeaf)
  } finally {
    $store.Close()
  }
  if (-not (Test-Path -LiteralPath "Cert:\LocalMachine\Root\$($leaf.Thumbprint)")) { throw 'the pilot leaf was not added to LocalMachine\Root' }
  Write-Host "pilot leaf trusted on this runner only: $($leaf.Thumbprint)"
}

# The leaf must chain to itself as the trusted root: nothing else may be the anchor.
function Assert-LeafChain($leaf) {
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  try {
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    $built = $chain.Build($leaf)
    $top = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Thumbprint
    $selfRooted = ($chain.ChainElements.Count -eq 1), ($top -eq $leaf.Thumbprint)
    if (-not $built -or $selfRooted -contains $false) {
      $status = (@($chain.ChainStatus) | ForEach-Object { $_.Status }) -join ','
      throw "the pilot leaf does not chain to itself as the trusted root (built=$built, status=$status)"
    }
  } finally {
    $chain.Reset()
  }
  Write-Host 'pilot leaf is its own trusted root on this runner'
}

# The checks every pilot leaf passes, release PFX or ephemeral: exact subject, self-signed, Code Signing only,
# not a CA.
function Assert-PilotLeafShape($leaf) {
  if ($leaf.Subject -cne $leafSubject) { throw "the certificate is not the pilot certificate (subject: $($leaf.Subject))" }
  if ($leaf.Issuer -cne $leaf.Subject) { throw "the pilot certificate is not self-signed (issuer: $($leaf.Issuer))" }
  $eku = @($leaf.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] })
  $purposes = @($eku | ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
  if ($purposes.Count -ne 1 -or $purposes[0] -ne $codeSigningOid) {
    throw "the pilot certificate must have the Code Signing purpose only (got: $($purposes -join ','))"
  }
  Assert-NotCa $leaf
}

# The owner script always writes a critical CA=false Basic Constraints extension: a leaf without one is refused.
function Assert-NotCa($leaf) {
  $basic = @($leaf.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension] }) | Select-Object -First 1
  if (-not $basic) { throw 'the pilot certificate has no Basic Constraints extension: refusing it' }
  if ($basic.CertificateAuthority) { throw 'the pilot certificate is a CA: refusing it' }
}

# The signing inputs from the environment. The two secrets are removed from the environment at once: from here
# on no child process (electron-builder, signtool, npx) inherits them.
function Read-ReleaseInputs {
  $encoded = $env:POS_PILOT_SIGN_PFX_BASE64
  $secret = $env:POS_PILOT_SIGN_PFX_PASSWORD
  $pinned = ("$env:POS_PILOT_LEAF_SHA1" -replace '\s', '').ToUpperInvariant()
  foreach ($name in 'POS_PILOT_SIGN_PFX_BASE64', 'POS_PILOT_SIGN_PFX_PASSWORD') {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  if (-not $encoded -or -not $secret) { throw 'release mode needs POS_PILOT_SIGN_PFX_BASE64 and POS_PILOT_SIGN_PFX_PASSWORD' }
  if ($pinned -notmatch '^[0-9A-F]{40}$') {
    throw 'POS_PILOT_LEAF_SHA1 must be the 40 hex character SHA-1 thumbprint of the pilot leaf'
  }
  return [pscustomobject]@{ Bytes = [Convert]::FromBase64String($encoded); Password = $secret; Pinned = $pinned }
}

# Reads the PFX in memory and checks the leaf BEFORE anything is imported or trusted.
function Read-PilotLeaf($inputs) {
  $all = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
  $all.Import($inputs.Bytes, $inputs.Password, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
  if ($all.Count -ne 1) { throw "the PFX must hold exactly one certificate (the self-signed pilot leaf), found $($all.Count)" }
  $leaf = $all[0]
  if (-not $leaf.HasPrivateKey) { throw 'the PFX certificate has no private key' }
  if ($leaf.Thumbprint -ne $inputs.Pinned) { throw "the PFX leaf ($($leaf.Thumbprint)) is not the pinned one (POS_PILOT_LEAF_SHA1)" }
  Assert-PilotLeafShape $leaf
  if ($leaf.NotAfter -lt (Get-Date).AddDays(30)) {
    throw "the pilot leaf expires on $($leaf.NotAfter.ToString('yyyy-MM-dd')), less than 30 days away: issue a new one (new-pilot-release-cert.ps1)"
  }
  return $leaf
}

# The leaf goes into CurrentUser\My through the .NET store API, with a persisted key that is not marked exportable.
function Save-PilotLeaf($inputs, [string]$thumbprint) {
  $persistFlags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet -bor [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet
  $persisted = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
  $persisted.Import($inputs.Bytes, $inputs.Password, $persistFlags)
  $leafToStore = @($persisted | Where-Object { $_.HasPrivateKey -and $_.Thumbprint -eq $thumbprint }) | Select-Object -First 1
  if (-not $leafToStore) { throw 'the pilot leaf could not be loaded from the PFX with a persisted key' }
  Register-Thumbprint 'userStore' $thumbprint
  $userStore = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')
  try {
    $userStore.Open('ReadWrite')
    $userStore.Add($leafToStore)
  } finally {
    $userStore.Close()
  }
  $stored = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint"
  if (-not $stored.HasPrivateKey) { throw 'the stored pilot leaf has no private key' }
  return $stored
}

function Initialize-ReleaseCertificate($ctx) {
  $inputs = Read-ReleaseInputs
  $leaf = Read-PilotLeaf $inputs
  $stored = Save-PilotLeaf $inputs $leaf.Thumbprint
  Add-LeafTrust $stored
  Assert-LeafChain $stored
  $ctx.leaf = $stored.Thumbprint
  Write-Host "release certificate ready: leaf=$($stored.Thumbprint) expires $($leaf.NotAfter.ToString('yyyy-MM-dd'))"
}

function Initialize-DryRunCertificate($ctx) {
  # New-SelfSignedCertificate lives in Windows PowerShell's PKI module, so a helper FILE runs under
  # powershell.exe (as the lab flow does): a file, not an inline command, so no argument quoting can break it.
  # The ephemeral leaf has the real pilot subject so the same checks run; it is untrusted everywhere but on this
  # runner, and is removed by -Cleanup. Assert-PilotLeafShape below re-checks what the helper made.
  $helper = Join-Path $repo 'scripts\pilot\ci\new-dry-run-leaf.ps1'
  $made = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper
  if ($LASTEXITCODE -ne 0) { throw 'creating the ephemeral pilot leaf failed' }
  $thumbprint = (@($made) | Select-Object -Last 1).ToString().Trim()
  if ($thumbprint -notmatch '^[0-9A-Fa-f]{40}$') { throw "the ephemeral pilot leaf has no usable thumbprint: $thumbprint" }
  Register-Thumbprint 'userStore' $thumbprint
  $leaf = Get-Item -LiteralPath "Cert:\CurrentUser\My\$thumbprint"
  if (-not $leaf.HasPrivateKey) { throw 'the ephemeral pilot leaf has no private key' }
  Assert-PilotLeafShape $leaf
  Add-LeafTrust $leaf
  Assert-LeafChain $leaf
  $ctx.leaf = $leaf.Thumbprint
  Write-Host "dry-run certificate ready: leaf=$($leaf.Thumbprint)"
}

# electron-builder does not sign the executable of an app it did not pack, so `POS Pulse.exe` is signed here
# when it is not already signed by the pilot leaf. The pilot hook is the one electron-builder itself calls: it
# refuses any certificate whose subject is not exactly the pilot subject and always timestamps.
# POS_PILOT_CERT_SHA1 and POS_PILOT_TSA_URL must be set.
function Sign-PrepackagedExe([string]$unpackedDir, [string]$leafThumbprint) {
  $exe = Join-Path $unpackedDir 'POS Pulse.exe'
  $sig = Get-AuthenticodeSignature -LiteralPath $exe
  if ($sig.SignerCertificate -and $sig.SignerCertificate.Thumbprint -eq $leafThumbprint) {
    Write-Host 'POS Pulse.exe is already signed by the pilot certificate'
    return
  }
  Write-Host 'POS Pulse.exe is not signed by the pilot certificate: signing it with the pilot hook'
  $hook = Join-Path $repo 'scripts\pilot\pilot-sign.cjs'
  & node -e 'require(process.argv[1])({ path: process.argv[2] }).catch((e) => { console.error(e.message); process.exit(1); })' $hook $exe
  if ($LASTEXITCODE -ne 0) { throw 'signing POS Pulse.exe failed' }
}

function Assert-PilotSignature([string]$path, [string]$leafThumbprint) {
  $name = Split-Path -Leaf $path
  if (-not (Test-Path -LiteralPath $path)) { throw "$name is missing" }
  $sig = Get-AuthenticodeSignature -LiteralPath $path
  if ($sig.Status -ne 'Valid') { throw "$name signature status is $($sig.Status), expected Valid" }
  $cn = $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if (-not ($cn -ceq $signerCn)) { throw "$name is signed by '$cn', expected '$signerCn'" }
  if ($sig.SignerCertificate.Thumbprint -ne $leafThumbprint) { throw "$name is signed by another certificate than the pilot leaf ($($sig.SignerCertificate.Thumbprint))" }
  if (-not $sig.TimeStamperCertificate) { throw "$name carries no timestamp: a pilot signature is always timestamped" }
  Write-Host "[OK] $name signed by $cn ($($sig.SignerCertificate.Thumbprint)), timestamped"
}

# The pilot installer must ship NO update configuration: without resources\app-update.yml the updater refuses
# to run (publisher_not_pinned), so an update origin set by mistake can never update a pilot terminal.
function Assert-NoAppUpdateConfig([string]$dir, [string]$label) {
  $path = Join-Path $dir 'resources\app-update.yml'
  if (Test-Path -LiteralPath $path) {
    throw "$label has resources\app-update.yml: the pilot installer must ship no update configuration"
  }
  Write-Host "[OK] $label has no resources\app-update.yml"
}

# The per-user install location is not assumed. The Uninstall key's UninstallString is the quoted uninstaller
# path, so the install directory is its parent. Then the installed executable and uninstaller must be signed
# by the pilot leaf and the installed tree must hold no app-update.yml, then a silent uninstall. The
# uninstaller runs in place (`_?=`) so this waits for it.
function Get-InstallLocation([string]$expectedVersion) {
  $keys = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue
  $entry = @($keys | Where-Object { $_.DisplayName -like 'POS Pulse*' -and $_.DisplayVersion -eq $expectedVersion -and $_.UninstallString }) |
    Select-Object -First 1
  if (-not $entry) { return $null }
  $quoted = [regex]::Match([string]$entry.UninstallString, '^"([^"]+)"')
  if (-not $quoted.Success) { throw "the POS Pulse UninstallString is not a quoted executable path: $($entry.UninstallString)" }
  $uninstallerPath = $quoted.Groups[1].Value
  return [pscustomobject]@{ Dir = (Split-Path -Parent $uninstallerPath); Uninstaller = $uninstallerPath }
}

function Wait-InstallLocation([string]$expectedVersion) {
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline) {
    $location = Get-InstallLocation $expectedVersion
    if ($location) { return $location }
    Start-Sleep -Seconds 2
  }
  return $null
}

function Assert-PerUserLocation([string]$installDir) {
  $perUserRoot = $env:LOCALAPPDATA.TrimEnd('\') + '\'
  if (-not $installDir.StartsWith($perUserRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "the install location is not per-user (under LOCALAPPDATA): $installDir"
  }
}

function Test-SilentInstall([string]$installer, [string]$leafThumbprint, [string]$expectedVersion) {
  $proc = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait
  if ($proc.ExitCode -ne 0) { throw "silent install exited with $($proc.ExitCode)" }
  $location = Wait-InstallLocation $expectedVersion
  if (-not $location) { throw "no HKCU Uninstall entry with an UninstallString for POS Pulse $expectedVersion after the silent install" }
  $installDir = $location.Dir
  Assert-PerUserLocation $installDir
  Write-Host "installed to $installDir"
  $app = Join-Path $installDir 'POS Pulse.exe'
  $uninstaller = Join-Path $installDir 'Uninstall POS Pulse.exe'
  if ($location.Uninstaller -ne $uninstaller) { throw "the UninstallString names $($location.Uninstaller), expected $uninstaller" }
  # The installer may start the app when it finishes; it must not be running when it is uninstalled.
  Get-Process 'POS Pulse' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $uninstallExit = $null
  try {
    Assert-PilotSignature $app $leafThumbprint
    Assert-PilotSignature $uninstaller $leafThumbprint
    Assert-NoAppUpdateConfig $installDir 'the installed app'
  } finally {
    if (Test-Path -LiteralPath $uninstaller) {
      $uninstallExit = (Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$installDir" -PassThru -Wait).ExitCode
    }
  }
  if ($uninstallExit -ne 0) { throw "silent uninstall exited with $uninstallExit" }
  Write-Host '[OK] silent install and uninstall'
}

# The trust store is written and a signing key is persisted below: only a GitHub-hosted runner is thrown away
# afterwards, so refuse anywhere else (a self-hosted runner or a developer machine would keep both).
function Assert-HostedRunner {
  if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'this script writes to the certificate stores and runs on a GitHub-hosted runner only (GITHUB_ACTIONS, RUNNER_ENVIRONMENT)'
  }
}

# A stray production signing or publishing variable must never reach this build: electron-builder bakes an
# update feed when a publish token is set.
function Clear-StrayEnvironment {
  foreach ($name in 'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD', 'GH_TOKEN', 'GITHUB_TOKEN', 'BT_TOKEN') {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
}

# Everything the build is refused for before any certificate exists.
function Assert-ReleaseInputs([string]$unpacked, [string]$out, [string]$version) {
  if ((Test-Path -LiteralPath $out) -and (Get-ChildItem -LiteralPath $out -Force | Select-Object -First 1)) {
    throw "-Out must be empty: $out"
  }
  foreach ($required in 'POS Pulse.exe', 'resources\app.asar') {
    if (-not (Test-Path -LiteralPath (Join-Path $unpacked $required))) { throw "-Unpacked is not a win-unpacked directory: $required is missing" }
  }
  Assert-NoAppUpdateConfig $unpacked 'the prepackaged win-unpacked'
  $packageVersion = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
  if ($packageVersion -ne $version) {
    throw "package.json is $packageVersion but -Version is ${version}: the packaged app takes its version from package.json"
  }
}

function Initialize-Workspace {
  New-Item -ItemType Directory -Force -Path $work | Out-Null
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
}

# Sets $ctx.leaf to the thumbprint of the leaf that signs.
function Initialize-SigningCertificate([string]$mode, $ctx) {
  if ($mode -eq 'release') { Initialize-ReleaseCertificate $ctx } else { Initialize-DryRunCertificate $ctx }
  $env:POS_PILOT_CERT_SHA1 = $ctx.leaf
  if (-not $env:POS_PILOT_TSA_URL) { throw 'POS_PILOT_TSA_URL must be set: a pilot signature is always timestamped' }
}

function Build-Installer([string]$unpacked, [string]$installer) {
  npx electron-builder --win nsis --config electron-builder.pilot.yml --prepackaged $unpacked --publish never "-c.directories.output=$stage"
  if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }
  if (-not (Test-Path -LiteralPath $installer)) { throw "electron-builder did not produce $(Split-Path -Leaf $installer)" }
  Assert-NoAppUpdateConfig $unpacked 'the prepackaged win-unpacked after the build'
}

function Invoke-PilotRelease([string]$mode, [string]$unpacked, [string]$out, [string]$version) {
  Assert-HostedRunner
  # Paths are resolved against the caller's directory before the working directory changes.
  $unpacked = (Resolve-Path -LiteralPath $unpacked).Path
  $out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($out)
  Clear-StrayEnvironment
  Assert-ReleaseInputs $unpacked $out $version
  Set-Location $repo
  Initialize-Workspace

  $ctx = @{}
  Initialize-SigningCertificate $mode $ctx
  Sign-PrepackagedExe $unpacked $ctx.leaf

  $installerName = "POS-Pulse-Setup-$version.exe"
  $installer = Join-Path $stage $installerName
  Build-Installer $unpacked $installer
  Assert-PilotSignature $installer $ctx.leaf
  Test-SilentInstall $installer $ctx.leaf $version

  New-Item -ItemType Directory -Force -Path $out | Out-Null
  Copy-Item -LiteralPath $installer -Destination $out
  Write-Host "[DONE] $mode build verified: $installerName in $out"
}

try {
  Invoke-PilotRelease $Mode $Unpacked $Out $Version
} catch {
  Write-Host "[FAIL] $($_.Exception.Message)"
  exit 1
}

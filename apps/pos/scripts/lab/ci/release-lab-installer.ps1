<#
.SYNOPSIS
  RT-1082 - turn a prebuilt `win-unpacked` directory into the lab-signed per-user NSIS installer,
  verify it, and hand over exactly three files. For an EPHEMERAL GitHub Actions Windows runner only.

.DESCRIPTION
  Not for a developer machine: it adds certificates to CurrentUser\My, trusts ONE public lab root in
  LocalMachine\Root, and silently installs and uninstalls the app. `-Cleanup` removes every
  certificate it added (recorded in a state file under RUNNER_TEMP); the workflow runs it
  with `if: always()`.

  Modes
    release  signs with the stable lab leaf from POS_LAB_SIGN_PFX_BASE64 / POS_LAB_SIGN_PFX_PASSWORD.
             The only root ever trusted is the one whose SHA-1 thumbprint equals POS_LAB_ROOT_SHA1;
             a PFX that does not contain it is refused (fail closed). Only the leaf is added to
             CurrentUser\My, through the .NET store API with a persisted non-exportable key; the
             PFX bytes stay in memory and are never written to disk.
    dry-run  signs with an ephemeral pair from new-lab-signing-cert.ps1 (2-day leaf, 3-day root) and
             reads no secret. It proves the build from the prepackaged app, the lab signing hook,
             the installer / lab.yml / installed-file checks and the silent install and uninstall.
             It does NOT exercise the release-only certificate path (in-memory PFX parse, leaf
             import, pinned-root check, trusting the root from the PFX): that path is first proven
             by the first real release.

  Steps: clear production signing variables -> certificate -> sign the prepackaged executable if
  electron-builder will not -> bake resources\app-update.yml (electron-builder does not write it for a
  prepackaged app, and the updater refuses to run without its publisher pin) -> build the installer
  from the prepackaged app with the lab config (never publishing) -> verify (installer signature,
  lab.yml, silent install, installed files and installed app-update.yml, silent uninstall) -> copy the
  installer, its blockmap and lab.yml into -Out.

  Every verification failure is a hard failure (non-zero exit). Nothing secret is printed.

.PARAMETER Mode
  release or dry-run.
.PARAMETER Unpacked
  The `win-unpacked` directory built (and fused) by the earlier secret-free job.
.PARAMETER Version
  X.Y.Z. It must equal the version in package.json: the packaged app is not re-stamped here.
.PARAMETER Out
  Empty or absent directory that receives POS-Pulse-LAB-Setup-<Version>.exe, its .blockmap and lab.yml.
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
$marker = 'LAB TEST - NOT FOR PRODUCTION'
$leafSubject = "CN=Kemetra POS $marker"
$rootSubject = "CN=Kemetra POS $marker ROOT"
# The publisher the baked updater pins; compared case-sensitively against the signer's CN.
$signerCn = 'Kemetra POS LAB TEST - NOT FOR PRODUCTION'

if (-not $env:RUNNER_TEMP) { throw 'RUNNER_TEMP is not set: this script is for an ephemeral GitHub runner only' }
$work = Join-Path $env:RUNNER_TEMP 'lab-release'
$statePath = Join-Path $work 'state.json'
$certDir = Join-Path $work 'certs'
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
function Remove-LabCertificate([string]$path, [switch]$DeleteKey) {
  # Only a full 40-hex thumbprint path: an empty value must never address the whole store.
  if ($path -notmatch '\\[0-9A-Fa-f]{40}$') { return }
  if (-not (Test-Path -LiteralPath $path)) { return }
  if ($DeleteKey) { Remove-Item -LiteralPath $path -DeleteKey -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
}

function Remove-LabTrust {
  Get-Process 'POS Pulse' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $statePath)) { return }
  $saved = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  foreach ($t in @($saved.rootStore)) { Remove-LabCertificate "Cert:\LocalMachine\Root\$t" }
  foreach ($t in @($saved.userStore)) { Remove-LabCertificate "Cert:\CurrentUser\My\$t" -DeleteKey }
  Write-Host 'lab certificates removed from LocalMachine\Root and CurrentUser\My'
}

if ($Cleanup) { Remove-LabTrust; exit 0 }

# Trusts one PUBLIC root for Authenticode verification on this runner. The object added is rebuilt
# from its public bytes, so no key material can come with it.
function Add-RootTrust($root) {
  Register-Thumbprint 'rootStore' $root.Thumbprint
  $publicRoot = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([byte[]]$root.RawData)
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
  try {
    $store.Open('ReadWrite')
    $store.Add($publicRoot)
  } finally {
    $store.Close()
  }
  if (-not (Test-Path -LiteralPath "Cert:\LocalMachine\Root\$($root.Thumbprint)")) { throw 'the lab root was not added to LocalMachine\Root' }
  Write-Host "lab root trusted on this runner: $($root.Thumbprint)"
}

# The leaf must chain to exactly the expected root (not merely to a root with the same name).
function Assert-LeafChain($leaf, [string]$rootThumbprint, $extraCerts) {
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  try {
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    if ($extraCerts) { $chain.ChainPolicy.ExtraStore.AddRange($extraCerts) }
    $built = $chain.Build($leaf)
    $top = $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Thumbprint
    if (-not $built -or $top -ne $rootThumbprint) {
      $status = (@($chain.ChainStatus) | ForEach-Object { $_.Status }) -join ','
      throw "the lab leaf does not chain to the expected lab root (built=$built, status=$status)"
    }
  } finally {
    $chain.Reset()
  }
  Write-Host 'lab leaf chains to the trusted lab root'
}

function Initialize-ReleaseCertificate($ctx) {
  $encoded = $env:POS_LAB_SIGN_PFX_BASE64
  $secret = $env:POS_LAB_SIGN_PFX_PASSWORD
  $pinnedRoot = ("$env:POS_LAB_ROOT_SHA1" -replace '\s', '').ToUpperInvariant()
  # From here on no child process (electron-builder, signtool, npx) inherits the signing secrets.
  foreach ($name in 'POS_LAB_SIGN_PFX_BASE64', 'POS_LAB_SIGN_PFX_PASSWORD') {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  if (-not $encoded -or -not $secret) { throw 'release mode needs POS_LAB_SIGN_PFX_BASE64 and POS_LAB_SIGN_PFX_PASSWORD' }
  if ($pinnedRoot -notmatch '^[0-9A-F]{40}$') {
    throw 'POS_LAB_ROOT_SHA1 must be the 40 hex character SHA-1 thumbprint of the lab root'
  }
  $pfxBytes = [Convert]::FromBase64String($encoded)

  # Read the PFX in memory first: find the pinned root and the leaf BEFORE anything is imported
  # or trusted. Whatever other root happens to be in the PFX is never used.
  $all = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
  $all.Import($pfxBytes, $secret, [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet)
  $root = @($all | Where-Object { $_.Thumbprint -eq $pinnedRoot }) | Select-Object -First 1
  if (-not $root) {
    throw 'the PFX does not contain the pinned root (POS_LAB_ROOT_SHA1): re-export the leaf with its chain, or fix the pin. Nothing was imported or trusted.'
  }
  # new-lab-release-cert.ps1 names the release root differently from the dry-run helper's root.
  $releaseRootSubject = 'CN=Kemetra POS LAB TEST - NOT FOR PRODUCTION RELEASE ROOT'
  if ($root.Subject -ne $releaseRootSubject) { throw "the pinned root is not the lab release root (subject: $($root.Subject))" }
  $withKey = @($all | Where-Object { $_.HasPrivateKey })
  if ($withKey.Count -ne 1) { throw "the PFX must hold exactly one certificate with a private key, found $($withKey.Count)" }
  $leaf = $withKey[0]
  if ($leaf.Subject -ne $leafSubject) { throw "the PFX leaf is not the lab certificate (subject: $($leaf.Subject))" }
  if ($leaf.NotAfter -lt (Get-Date).AddDays(30)) {
    throw "the lab leaf expires on $($leaf.NotAfter.ToString('yyyy-MM-dd')), less than 30 days away: issue a new one (new-lab-release-cert.ps1)"
  }

  # Only the leaf goes into CurrentUser\My, through the .NET store API, with a persisted key that is
  # not marked exportable. The PFX's root is never added to any store from the PFX: a user-level Root
  # add raises a modal prompt, and the root is trusted below from its public bytes in LocalMachine only.
  $persistFlags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::PersistKeySet -bor [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::UserKeySet
  $persisted = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2Collection
  $persisted.Import($pfxBytes, $secret, $persistFlags)
  $leafToStore = @($persisted | Where-Object { $_.HasPrivateKey -and $_.Thumbprint -eq $leaf.Thumbprint }) | Select-Object -First 1
  if (-not $leafToStore) { throw 'the lab leaf could not be loaded from the PFX with a persisted key' }
  Register-Thumbprint 'userStore' $leaf.Thumbprint
  $userStore = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')
  try {
    $userStore.Open('ReadWrite')
    $userStore.Add($leafToStore)
  } finally {
    $userStore.Close()
  }
  $stored = Get-Item -LiteralPath "Cert:\CurrentUser\My\$($leaf.Thumbprint)"
  if (-not $stored.HasPrivateKey) { throw 'the stored lab leaf has no private key' }

  Add-RootTrust $root
  Assert-LeafChain $stored $pinnedRoot $all
  $ctx.leaf = $stored.Thumbprint
  Write-Host "release certificate ready: leaf=$($stored.Thumbprint) root=$pinnedRoot expires $($leaf.NotAfter.ToString('yyyy-MM-dd'))"
}

function Initialize-DryRunCertificate($ctx) {
  New-Item -ItemType Directory -Force -Path $certDir | Out-Null
  $helper = Join-Path $repo 'scripts\lab\new-lab-signing-cert.ps1'
  # The helper's own default output is D:\; it is pointed at RUNNER_TEMP. Windows PowerShell runs it,
  # as in run-lab-spike.ps1, because New-SelfSignedCertificate lives in its PKI module.
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $helper -OutDir $certDir -LeafDays 2 -RootDays 3
  if ($LASTEXITCODE -ne 0) { throw 'new-lab-signing-cert.ps1 failed' }
  $leaf = Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.Subject -eq $leafSubject -and $_.HasPrivateKey } |
    Sort-Object NotAfter -Descending | Select-Object -First 1
  if (-not $leaf) { throw 'the ephemeral lab leaf is missing from CurrentUser\My' }
  $rootCer = Join-Path $certDir 'rt772-lab-root.cer'
  if (-not (Test-Path -LiteralPath $rootCer)) { throw 'the public lab root was not exported' }
  $root = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($rootCer)
  if ($root.Subject -ne $rootSubject) { throw "the exported root is not the lab root (subject: $($root.Subject))" }
  Register-Thumbprint 'userStore' $leaf.Thumbprint
  Register-Thumbprint 'userStore' $root.Thumbprint
  Add-RootTrust $root
  Assert-LeafChain $leaf $root.Thumbprint $null
  $ctx.leaf = $leaf.Thumbprint
  Write-Host "dry-run certificate ready: leaf=$($leaf.Thumbprint) root=$($root.Thumbprint)"
}

# electron-builder does not sign the executable of an app it did not pack (the C-6 fallback), so
# `POS Pulse.exe` is signed here when it is not already signed by the lab leaf. The lab hook is the
# one electron-builder itself would call: it signs through buildSigntoolArgs (lab-sign-lib.cjs) from
# CurrentUser\My, refusing any certificate without the lab marker. RT772_LAB_CERT_SHA1 must be set.
function Sign-PrepackagedExe([string]$unpackedDir, [string]$leafThumbprint) {
  $exe = Join-Path $unpackedDir 'POS Pulse.exe'
  $sig = Get-AuthenticodeSignature -LiteralPath $exe
  if ($sig.SignerCertificate -and $sig.SignerCertificate.Thumbprint -eq $leafThumbprint) {
    Write-Host 'POS Pulse.exe is already signed by the lab certificate'
    return
  }
  Write-Host 'POS Pulse.exe is not signed by the lab certificate: signing it with the lab hook'
  $hook = Join-Path $repo 'scripts\lab\lab-sign.cjs'
  & node -e 'require(process.argv[1])({ path: process.argv[2] }).catch((e) => { console.error(e.message); process.exit(1); })' $hook $exe
  if ($LASTEXITCODE -ne 0) { throw 'signing POS Pulse.exe failed' }
}

function Assert-LabSignature([string]$path, [string]$leafThumbprint) {
  $name = Split-Path -Leaf $path
  if (-not (Test-Path -LiteralPath $path)) { throw "$name is missing" }
  $sig = Get-AuthenticodeSignature -LiteralPath $path
  if ($sig.Status -ne 'Valid') { throw "$name signature status is $($sig.Status), expected Valid" }
  $cn = $sig.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  if (-not ($cn -ceq $signerCn)) { throw "$name is signed by '$cn', expected '$signerCn'" }
  if ($sig.SignerCertificate.Thumbprint -ne $leafThumbprint) { throw "$name is signed by another certificate than the lab leaf ($($sig.SignerCertificate.Thumbprint))" }
  Write-Host "[OK] $name signed by $cn ($($sig.SignerCertificate.Thumbprint))"
}

# Values of one YAML key wherever it appears (top level or inside the files list); lab.yml is flat enough
# that no YAML parser is needed.
function Get-YamlValues([string]$text, [string]$key) {
  $pattern = "(?m)^[ \t]*(?:-[ \t]+)?${key}:[ \t]*[\x27\x22]?([^\x27\x22\r\n]*?)[\x27\x22]?[ \t]*\r?$"
  @([regex]::Matches($text, $pattern) | ForEach-Object { $_.Groups[1].Value })
}

function Assert-ChannelFile([string]$ymlPath, [string]$installerPath, [string]$expectedVersion) {
  $text = Get-Content -LiteralPath $ymlPath -Raw
  $installerName = Split-Path -Leaf $installerPath
  $bytes = [System.IO.File]::ReadAllBytes($installerPath)
  $sha512 = [System.Security.Cryptography.SHA512]::Create()
  $digest = [Convert]::ToBase64String($sha512.ComputeHash($bytes))
  $expected = [ordered]@{
    version = $expectedVersion
    path    = $installerName
    url     = $installerName
    sha512  = $digest
    size    = [string]$bytes.Length
  }
  foreach ($key in $expected.Keys) {
    $values = @(Get-YamlValues $text $key)
    if ($values.Count -eq 0 -and $key -ne 'url') { throw "lab.yml has no '$key'" }
    foreach ($value in $values) {
      if ($value -cne $expected[$key]) { throw "lab.yml '$key' is '$value', expected '$($expected[$key])'" }
    }
  }
  Write-Host "[OK] lab.yml matches the installer (version $expectedVersion, sha512, size $($bytes.Length))"
}

# A YAML scalar as update-config.ts `unquote` reads it: trimmed, one pair of matching quotes removed.
function ConvertFrom-YamlScalar([string]$value) {
  $trimmed = $value.Trim()
  $quoted = [regex]::Match($trimmed, '^(["\x27])(.*)\1$')
  if ($quoted.Success) { return $quoted.Groups[2].Value.Trim() }
  return $trimmed
}

# The publisher pins of an app-update.yml, read exactly as the updater reads them (update-config.ts
# `parsePublisherPins`): the first `publisherName:` line, then its inline value or the `- item` lines
# that follow it. Case-sensitive, like the TypeScript regexes.
function Get-PublisherPins([string]$text) {
  $lines = $text -split '\r?\n'
  $start = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ([regex]::IsMatch($lines[$i], '^publisherName:\s*(.*)$')) { $start = $i; break }
  }
  if ($start -lt 0) { return @() }
  $inline = ConvertFrom-YamlScalar ([regex]::Match($lines[$start], '^publisherName:\s*(.*)$').Groups[1].Value)
  if ($inline -ne '') { return @($inline) }
  $pins = @()
  for ($i = $start + 1; $i -lt $lines.Count; $i++) {
    $item = [regex]::Match($lines[$i], '^\s+-\s*(.*)$')
    if (-not $item.Success) { break }
    $pins += ConvertFrom-YamlScalar $item.Groups[1].Value
  }
  return @($pins | Where-Object { $_ -ne '' })
}

function Assert-PublisherPin([string]$text, [string]$label) {
  $pins = @(Get-PublisherPins $text)
  if ($pins.Count -ne 1 -or -not ($pins[0] -ceq $signerCn)) {
    throw "$label pins [$($pins -join ' | ')], expected exactly '$signerCn': the updater would not accept this build"
  }
}

# electron-builder writes resources\app-update.yml from a hook that does not run for a prepackaged app, and
# the updater refuses to run without the publisher pin it holds. bake-app-update-yml.cjs writes exactly what
# electron-builder would bake for electron-builder.lab.yml (generic provider, url, channel, cache dir name,
# publisher list). It runs after the signing secrets left the environment. The file is outside app.asar.
function Write-AppUpdateConfig([string]$unpackedDir) {
  $helper = Join-Path $repo 'scripts\lab\ci\bake-app-update-yml.cjs'
  # Out-Host: nothing node prints may become part of this function's return value.
  & node $helper $unpackedDir $signerCn | Out-Host
  if ($LASTEXITCODE -ne 0) { throw 'baking resources\app-update.yml into win-unpacked failed' }
  $path = Join-Path $unpackedDir 'resources\app-update.yml'
  if (-not (Test-Path -LiteralPath $path)) { throw 'resources\app-update.yml is missing after baking it' }
  $text = [System.IO.File]::ReadAllText($path)
  Assert-PublisherPin $text 'the baked resources\app-update.yml'
  Write-Host "[OK] resources\app-update.yml baked with the publisher pin '$signerCn'"
  return $text
}

# The INSTALLED app must carry the same app-update.yml, with the lab publisher as its only pin.
function Assert-InstalledAppUpdateConfig([string]$installDir, [string]$bakedText) {
  $path = Join-Path $installDir 'resources\app-update.yml'
  if (-not (Test-Path -LiteralPath $path)) {
    throw 'the installed app has no resources\app-update.yml: its updater would refuse to run'
  }
  $text = [System.IO.File]::ReadAllText($path)
  Assert-PublisherPin $text 'the installed resources\app-update.yml'
  if ($text -cne $bakedText) { throw 'the installed resources\app-update.yml differs from the one baked into win-unpacked' }
  Write-Host "[OK] installed resources\app-update.yml pins '$signerCn'"
}

# The per-user install location is not assumed. electron-builder's NSIS template writes no InstallLocation
# to the Uninstall key (that value goes under Software\<APP_GUID>); the Uninstall key's UninstallString is
# the quoted uninstaller path, so the install directory is its parent (as run-lab-spike.ps1 does). Then the
# installed executable and uninstaller must be signed by the lab leaf and the installed app-update.yml must
# pin the lab publisher, then a silent uninstall. The uninstaller runs in place (`_?=`) so this waits for it.
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

function Test-SilentInstall([string]$installer, [string]$leafThumbprint, [string]$expectedVersion, [string]$bakedAppUpdate) {
  $proc = Start-Process -FilePath $installer -ArgumentList '/S' -PassThru -Wait
  if ($proc.ExitCode -ne 0) { throw "silent install exited with $($proc.ExitCode)" }
  $location = $null
  $deadline = (Get-Date).AddSeconds(60)
  while ((Get-Date) -lt $deadline -and -not $location) {
    $location = Get-InstallLocation $expectedVersion
    if (-not $location) { Start-Sleep -Seconds 2 }
  }
  if (-not $location) { throw "no HKCU Uninstall entry with an UninstallString for POS Pulse $expectedVersion after the silent install" }
  $installDir = $location.Dir
  $perUserRoot = $env:LOCALAPPDATA.TrimEnd('\') + '\'
  if (-not $installDir.StartsWith($perUserRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "the install location is not per-user (under LOCALAPPDATA): $installDir"
  }
  Write-Host "installed to $installDir"
  $app = Join-Path $installDir 'POS Pulse.exe'
  $uninstaller = Join-Path $installDir 'Uninstall POS Pulse.exe'
  if ($location.Uninstaller -ne $uninstaller) { throw "the UninstallString names $($location.Uninstaller), expected $uninstaller" }
  # The installer may start the app when it finishes; it must not be running when it is uninstalled.
  Get-Process 'POS Pulse' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $uninstallExit = $null
  try {
    Assert-LabSignature $app $leafThumbprint
    Assert-LabSignature $uninstaller $leafThumbprint
    Assert-InstalledAppUpdateConfig $installDir $bakedAppUpdate
  } finally {
    if (Test-Path -LiteralPath $uninstaller) {
      $uninstallExit = (Start-Process -FilePath $uninstaller -ArgumentList "/S _?=$installDir" -PassThru -Wait).ExitCode
    }
  }
  if ($uninstallExit -ne 0) { throw "silent uninstall exited with $uninstallExit" }
  Write-Host '[OK] silent install and uninstall'
}

try {
  # Paths are resolved against the caller's directory before the working directory changes.
  $Unpacked = (Resolve-Path -LiteralPath $Unpacked).Path
  $Out = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Out)

  # A stray production signing variable must never reach this build.
  foreach ($name in 'CSC_LINK', 'CSC_KEY_PASSWORD', 'CSC_NAME', 'WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD') {
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }

  if ((Test-Path -LiteralPath $Out) -and (Get-ChildItem -LiteralPath $Out -Force | Select-Object -First 1)) {
    throw "-Out must be empty: $Out"
  }
  foreach ($required in 'POS Pulse.exe', 'resources\app.asar') {
    if (-not (Test-Path -LiteralPath (Join-Path $Unpacked $required))) { throw "-Unpacked is not a win-unpacked directory: $required is missing" }
  }
  Set-Location $repo
  $packageVersion = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
  if ($packageVersion -ne $Version) {
    throw "package.json is $packageVersion but -Version is ${Version}: the packaged app takes its version from package.json"
  }

  New-Item -ItemType Directory -Force -Path $work | Out-Null
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stage | Out-Null

  $ctx = @{}
  if ($Mode -eq 'release') { Initialize-ReleaseCertificate $ctx } else { Initialize-DryRunCertificate $ctx }
  $env:RT772_LAB_CERT_SHA1 = $ctx.leaf

  Sign-PrepackagedExe $Unpacked $ctx.leaf
  $appUpdateYml = Write-AppUpdateConfig $Unpacked

  npx electron-builder --win nsis --config electron-builder.lab.yml --prepackaged $Unpacked --publish never "-c.directories.output=$stage"
  if ($LASTEXITCODE -ne 0) { throw 'electron-builder failed' }

  $installerName = "POS-Pulse-LAB-Setup-$Version.exe"
  $installer = Join-Path $stage $installerName
  $blockmap = Join-Path $stage "$installerName.blockmap"
  $channel = Join-Path $stage 'lab.yml'
  foreach ($produced in $installer, $blockmap, $channel) {
    if (-not (Test-Path -LiteralPath $produced)) { throw "electron-builder did not produce $(Split-Path -Leaf $produced)" }
  }

  Assert-LabSignature $installer $ctx.leaf
  Assert-ChannelFile $channel $installer $Version
  Test-SilentInstall $installer $ctx.leaf $Version $appUpdateYml

  New-Item -ItemType Directory -Force -Path $Out | Out-Null
  foreach ($produced in $installer, $blockmap, $channel) { Copy-Item -LiteralPath $produced -Destination $Out }
  Write-Host "[DONE] $Mode build verified: $installerName, $installerName.blockmap, lab.yml in $Out"
} catch {
  Write-Host "[FAIL] $($_.Exception.Message)"
  exit 1
}

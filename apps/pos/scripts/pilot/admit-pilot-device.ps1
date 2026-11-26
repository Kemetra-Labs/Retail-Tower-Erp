<#
.SYNOPSIS
  RT-1611 (RT-1290 P5) - owner-run: admit ONE pilot device to trust the pinned pilot signing leaf, or remove it.

.DESCRIPTION
  A pilot installer (RT-1294) is signed by a self-signed leaf, subject CN=Kemetra POS PILOT. Windows validates
  that signature only on a device where the leaf was admitted as a trusted root. This script does that for the
  device it runs on, and nothing else.

  The certificate comes from the downloaded installer itself (its Authenticode signer), not from a separate file.
  Before anything is written it checks, and refuses on any failure:
    - the installer's SHA-256 equals -ExpectedSha256 (the value on Admin Console -> Devices -> Download POS);
    - the file carries an intact signature (not NotSigned, HashMismatch, NotSupportedFileFormat, Incompatible);
    - the signer's SHA-1 thumbprint equals -PinnedThumbprint (POS_PILOT_LEAF_SHA1, from the owner's records);
    - the subject is exactly CN=Kemetra POS PILOT and the certificate is self-signed;
    - its only purpose is Code Signing, it has a Basic Constraints extension and is not a CA;
    - it has not expired;
    - this PowerShell runs elevated (writing LocalMachine\Root needs local admin).

  Admitting adds only the PUBLIC bytes of that one certificate to LocalMachine\Root (the same store the CI
  verifier uses). It never touches TrustedPublisher, any CurrentUser store, or any other certificate. Afterwards
  the installer's signature must read Valid, signed by the pinned leaf; if not, the leaf is removed again and the
  script fails.

  -VerifyOnly runs every check and writes nothing (no elevation needed).
  -Remove removes the pinned pilot leaf from LocalMachine\Root (revocation, rotation); it removes nothing else.

  Only on a device the owner has named and accepted on RT-1290 (P-6). Windows PowerShell 5.1 compatible.

.EXAMPLE
  .\admit-pilot-device.ps1 -InstallerPath .\POS-Pulse-Setup-0.1.6.exe -ExpectedSha256 <sha256> -PinnedThumbprint <sha1> -VerifyOnly
#>
[CmdletBinding(DefaultParameterSetName = 'Admit')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Admit')][string]$InstallerPath,
  [Parameter(Mandatory, ParameterSetName = 'Admit')][string]$ExpectedSha256,
  [Parameter(Mandatory)][string]$PinnedThumbprint,
  [Parameter(ParameterSetName = 'Admit')][switch]$VerifyOnly,
  [Parameter(Mandatory, ParameterSetName = 'Remove')][switch]$Remove
)

$ErrorActionPreference = 'Stop'

$pilotSubject = 'CN=Kemetra POS PILOT'
$codeSigningOid = '1.3.6.1.5.5.7.3.3'
$rootPath = 'Cert:\LocalMachine\Root'
# An intact signature whose self-signed root is not trusted yet reads UnknownError; an admitted device reads Valid.
# NotTrusted means the certificate is explicitly distrusted (the Disallowed store): never admit that.
$acceptedStatus = @('Valid', 'UnknownError')

# Non-printing characters (certlm.msc copies a U+200E mark with a thumbprint) and spaces are dropped.
$pin = ($PinnedThumbprint -replace '[^\x21-\x7E]', '').ToUpperInvariant()
if ($pin -notmatch '^[0-9A-F]{40}$') { throw 'PinnedThumbprint must be the 40 hex character SHA-1 thumbprint of the pilot leaf' }

function Assert-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'run this from PowerShell as Administrator: LocalMachine\Root needs local admin'
  }
}

function Assert-InstallerHash([string]$path, [string]$expected) {
  $want = ($expected -replace '\s', '').ToLowerInvariant() -replace '^sha256:', ''
  if ($want -notmatch '^[0-9a-f]{64}$') { throw 'ExpectedSha256 must be the 64 hex character SHA-256 shown on Download POS' }
  $got = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($got -ne $want) { throw "the installer's SHA-256 is $got, not the expected ${want}: delete the file, do not run it" }
  Write-Host "[OK] installer SHA-256 matches: $got"
}

function Assert-OnlyUntrustedRoot($cert) {
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  try {
    $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
    [void]$chain.Build($cert)
    $reasons = @($chain.ChainStatus | ForEach-Object { [string]$_.Status } | Sort-Object -Unique)
    if ($chain.ChainElements.Count -ne 1 -or $reasons.Count -ne 1 -or $reasons[0] -ne 'UntrustedRoot') {
      throw "the installer signature is invalid for another reason than an untrusted pilot root (chain: $($reasons -join ',')): do not run it"
    }
  } finally {
    $chain.Reset()
  }
}

# One admission or removal at a time on this machine, so a rollback can never remove a leaf another run just added.
function Enter-AdmissionLock {
  $mutex = New-Object System.Threading.Mutex($false, "Global\RT1611-pilot-device-admission-$pin")
  try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
  if (-not $owned) { throw 'another admission or removal is running on this machine: wait for it to finish, then run again' }
  return $mutex
}

function Get-SignerLeaf([string]$path) {
  $sig = Get-AuthenticodeSignature -LiteralPath $path
  if ([string]$sig.Status -eq 'NotTrusted') {
    throw 'the signer is explicitly distrusted on this device (Disallowed store): do not admit it'
  }
  if ($acceptedStatus -notcontains [string]$sig.Status) {
    throw "the installer has no intact signature (status: $($sig.Status)): do not run it"
  }
  if ([string]$sig.SignatureType -ne 'Authenticode') { throw "the installer is not Authenticode-signed (type: $($sig.SignatureType))" }
  if (-not $sig.SignerCertificate) { throw 'the installer signature names no signer certificate' }
  # UnknownError also covers other invalid-signature cases, not only an untrusted root. Accept it only when the
  # signer's own chain fails for exactly one reason: its self-signed root is not trusted yet. After admission the
  # file must still read Valid (checked below), which also proves the signature itself is intact.
  if ([string]$sig.Status -eq 'UnknownError') { Assert-OnlyUntrustedRoot $sig.SignerCertificate }
  # Rebuild from the public bytes, so nothing but the certificate itself can be added later.
  return [System.Security.Cryptography.X509Certificates.X509Certificate2]::new([byte[]]$sig.SignerCertificate.RawData)
}

# The same shape checks the CI release script applies to every pilot leaf (Assert-PilotLeafShape, Assert-NotCa).
function Assert-PilotLeaf($leaf) {
  if ($leaf.Thumbprint -ne $pin) { throw "the installer is signed by $($leaf.Thumbprint), not the pinned pilot leaf ${pin}: refusing" }
  if ($leaf.Subject -cne $pilotSubject) { throw "the signer is not the pilot certificate (subject: $($leaf.Subject))" }
  if ($leaf.Issuer -cne $leaf.Subject) { throw "the pilot certificate is not self-signed (issuer: $($leaf.Issuer))" }
  $eku = @($leaf.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension] })
  $purposes = @($eku | ForEach-Object { $_.EnhancedKeyUsages } | ForEach-Object { $_.Value })
  if ($purposes.Count -ne 1 -or $purposes[0] -ne $codeSigningOid) {
    throw "the pilot certificate must have the Code Signing purpose only (got: $($purposes -join ','))"
  }
  $basic = @($leaf.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension] }) | Select-Object -First 1
  if (-not $basic) { throw 'the pilot certificate has no Basic Constraints extension: refusing it' }
  if (-not $basic.Critical) { throw 'the pilot certificate Basic Constraints extension is not critical: refusing it' }
  if ($basic.CertificateAuthority) { throw 'the pilot certificate is a CA: refusing it' }
  # Key usage: digital signature, never certificate or CRL signing (the owner script writes DigitalSignature only).
  $ku = @($leaf.Extensions | Where-Object { $_ -is [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension] }) | Select-Object -First 1
  if (-not $ku) { throw 'the pilot certificate has no Key Usage extension: refusing it' }
  $flags = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]
  if (-not ($ku.KeyUsages -band $flags::DigitalSignature)) { throw "the pilot certificate cannot sign (key usage: $($ku.KeyUsages))" }
  if ($ku.KeyUsages -band ($flags::KeyCertSign -bor $flags::CrlSign)) { throw "the pilot certificate may sign certificates or CRLs (key usage: $($ku.KeyUsages)): refusing it" }
  $now = Get-Date
  if ($leaf.NotBefore -gt $now) { throw "the pilot certificate is not valid before $($leaf.NotBefore.ToString('yyyy-MM-dd')): refusing it" }
  if ($leaf.NotAfter -lt $now) { throw "the pilot certificate expired on $($leaf.NotAfter.ToString('yyyy-MM-dd')): refusing it" }
  Write-Host "[OK] signer is the pinned pilot leaf: $pilotSubject, $pin, self-signed, Code Signing only, not a CA, expires $($leaf.NotAfter.ToString('yyyy-MM-dd'))"
}

function Open-RootStore([string]$mode) {
  $store = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root', 'LocalMachine')
  $store.Open($mode)
  return $store
}

function Remove-PilotLeaf {
  $store = Open-RootStore 'ReadWrite'
  try {
    $found = @($store.Certificates | Where-Object { $_.Thumbprint -eq $pin })
    foreach ($cert in $found) {
      if ($cert.Subject -cne $pilotSubject) { throw "$pin in LocalMachine\Root is not the pilot certificate (subject: $($cert.Subject)): not removing it" }
      $store.Remove($cert)
    }
  } finally {
    $store.Close()
  }
  if (Test-Path -LiteralPath "$rootPath\$pin") { throw "the pilot leaf $pin is still in LocalMachine\Root" }
  return $found.Count
}

if ($PSCmdlet.ParameterSetName -eq 'Remove') {
  if (-not $Remove) { throw 'use -Remove to remove the pilot leaf' }
  Assert-Elevated
  $lock = Enter-AdmissionLock
  $removed = Remove-PilotLeaf
  if ($removed -gt 0) { Write-Host "[DONE] pilot leaf $pin removed from LocalMachine\Root" }
  else { Write-Host "[DONE] pilot leaf $pin was not in LocalMachine\Root; nothing removed" }
  exit 0
}

$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
Assert-InstallerHash $installer $ExpectedSha256
$leaf = Get-SignerLeaf $installer
Assert-PilotLeaf $leaf

if ($VerifyOnly) {
  $present = Test-Path -LiteralPath "$rootPath\$pin"
  Write-Host "[DONE] every check passed; nothing was written (already admitted: $present)"
  exit 0
}

Assert-Elevated
# Held until the process ends: the presence check, the write and any rollback run under it.
$lock = Enter-AdmissionLock
$already = Test-Path -LiteralPath "$rootPath\$pin"
if ($already) {
  Write-Host "[OK] pilot leaf $pin is already in LocalMachine\Root; not adding it again"
  $check = Get-AuthenticodeSignature -LiteralPath $installer
  if ([string]$check.Status -ne 'Valid' -or $check.SignerCertificate.Thumbprint -ne $pin) {
    throw "the pilot leaf was already present and was left in place, but the installer reads $($check.Status): investigate (Disallowed store? group policy?)"
  }
} else {
  # Anything that stops this block before $admitted is set (an error, Ctrl+C) removes the leaf again.
  $admitted = $false
  try {
    $leaf.FriendlyName = 'Kemetra POS PILOT (RT-1611 pilot device admission)'
    $store = Open-RootStore 'ReadWrite'
    try { $store.Add($leaf) } finally { $store.Close() }
    if (-not (Test-Path -LiteralPath "$rootPath\$pin")) { throw 'the pilot leaf was not added to LocalMachine\Root' }
    Write-Host "[OK] pilot leaf $pin added to LocalMachine\Root"
    $check = Get-AuthenticodeSignature -LiteralPath $installer
    if ([string]$check.Status -ne 'Valid' -or $check.SignerCertificate.Thumbprint -ne $pin) {
      throw "after admission the installer reads $($check.Status), not Valid from $pin; the leaf is being removed again"
    }
    $admitted = $true
  } finally {
    if (-not $admitted) {
      try { Remove-PilotLeaf | Out-Null; Write-Host "[ROLLBACK] pilot leaf $pin removed again" }
      catch { Write-Error "ROLLBACK FAILED: $pin may still be trusted on this device; run this script with -Remove" }
    }
  }
}
Write-Host "[DONE] admitted: $(Split-Path -Leaf $installer) reads Valid, signed by $pilotSubject ($pin)"

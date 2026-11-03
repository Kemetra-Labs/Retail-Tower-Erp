<#
.SYNOPSIS
  RT-1082 - owner-run: create the stable LAB-ONLY release root and an exportable code-signing leaf.

.DESCRIPTION
  Always creates NEW certificates in Cert:\CurrentUser\My (it never reuses one):
    - a long-lived lab release root CA whose private key is NON-EXPORTABLE;
    - a one-year code-signing leaf issued by that root, whose key IS exportable so the
      leaf can be exported as a password-protected PFX (with its chain) for CI.

  Only the PFX goes to the CI secret store (the release-pos-sign environment). Only the public
  root .cer goes to the lab device. The root private key never leaves this machine.

  This script never imports anything into a trust store, and never writes a password to disk or
  to the console: the PFX password is read with Read-Host -AsSecureString. The leaf subject is
  the baked publisher pin and carries "LAB TEST - NOT FOR PRODUCTION", so a production pin can
  never match it. The root subject is distinct from the 180-day drill root, so
  new-lab-signing-cert.ps1 never mistakes it for its own root.

  Windows PowerShell 5.1 compatible.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PfxPath,
  [Parameter(Mandatory)][string]$RootCerPath,
  [int]$RootDays = 730,
  [int]$LeafDays = 365
)

$ErrorActionPreference = 'Stop'

$marker = 'LAB TEST - NOT FOR PRODUCTION'
$store = 'Cert:\CurrentUser\My'

foreach ($path in @($PfxPath, $RootCerPath)) {
  if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite existing file: $path" }
  $dir = Split-Path -Parent $path
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

# Read the password first, so a typo costs nothing. It stays a SecureString; the plain text is
# only held in memory for the comparison and freed straight away.
$password = Read-Host 'PFX password' -AsSecureString
$confirm = Read-Host 'Repeat PFX password' -AsSecureString
$bstr1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
$bstr2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($confirm)
try {
  $plain1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr1)
  $plain2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr2)
  if ($plain1.Length -eq 0) { throw 'The PFX password must not be empty.' }
  if ($plain1 -cne $plain2) { throw 'The two PFX passwords do not match.' }
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr1)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr2)
  $plain1 = $null
  $plain2 = $null
}

$root = New-SelfSignedCertificate -Type Custom -Subject "CN=Kemetra POS $marker RELEASE ROOT" `
  -KeyUsage CertSign, CRLSign, DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy NonExportable -CertStoreLocation $store `
  -NotAfter (Get-Date).AddDays($RootDays) `
  -TextExtension @('2.5.29.19={critical}{text}CA=true&pathlength=0')

# A leaf never outlives its root.
$leafNotAfter = (Get-Date).AddDays($LeafDays)
if ($leafNotAfter -gt $root.NotAfter) { $leafNotAfter = $root.NotAfter }

$leaf = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=Kemetra POS $marker" -Signer $root `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable -CertStoreLocation $store `
  -NotAfter $leafNotAfter

Export-PfxCertificate -Cert $leaf -FilePath $PfxPath -Password $password -ChainOption BuildChain | Out-Null
Export-Certificate -Cert $root -FilePath $RootCerPath | Out-Null

Write-Host "POS_LAB_ROOT_SHA1 = $($root.Thumbprint)"
Write-Host "leaf expires $($leaf.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host ''
Write-Host "PFX (leaf + chain)  = $PfxPath"
Write-Host "public root         = $RootCerPath"
Write-Host 'Only the PFX goes to the release-pos-sign environment. Only the .cer goes to the lab device.'
Write-Host 'Nothing was imported into a trust store on this machine. The root private key is not exportable.'

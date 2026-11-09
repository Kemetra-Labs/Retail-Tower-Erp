<#
.SYNOPSIS
  RT-1294 - owner-run: create the PILOT release signing leaf (self-signed, leaf only).

.DESCRIPTION
  Always creates a NEW certificate in Cert:\CurrentUser\My (it never reuses one):
    - subject CN=Kemetra POS PILOT, RSA 3072, SHA-256;
    - Basic Constraints CA=false (critical) and Enhanced Key Usage Code Signing only, so the certificate
      can sign code but can never issue another certificate;
    - valid for -LeafDays days (default 365). A pilot signature is timestamped, so a signature made while
      the certificate was valid stays valid after it expires; a NEW installer needs a new certificate.

  Two files are written: a password-protected PFX (the only file that goes to the CI secret store, the
  release-pos-pilot-sign environment) and the public .cer (what a pilot device would later be admitted
  with, a separate decision). The leaf's SHA-1 thumbprint is printed: it is the public repository variable
  POS_PILOT_LEAF_SHA1 of that environment.

  This script never imports anything into a trust store, and never writes the password to disk or to the
  console: the PFX password is read with Read-Host -AsSecureString and passed as a SecureString.

  Windows PowerShell 5.1 compatible (New-SelfSignedCertificate lives in its PKI module).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$PfxPath,
  [Parameter(Mandatory)][string]$CerPath,
  [ValidateRange(60, 1095)][int]$LeafDays = 365
)

$ErrorActionPreference = 'Stop'

$subject = 'CN=Kemetra POS PILOT'
$store = 'Cert:\CurrentUser\My'

foreach ($path in @($PfxPath, $CerPath)) {
  if (Test-Path -LiteralPath $path) { throw "Refusing to overwrite existing file: $path" }
  $dir = Split-Path -Parent $path
  if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
}

# Read the password first, so a typo costs nothing. It stays a SecureString; the plain text is only held
# in memory for the comparison and freed straight away.
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

# CA=false and the Code Signing purpose only: this certificate cannot issue certificates.
$leaf = New-SelfSignedCertificate -Type Custom -Subject $subject `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy Exportable -CertStoreLocation $store `
  -NotAfter (Get-Date).AddDays($LeafDays) `
  -TextExtension @('2.5.29.19={critical}{text}CA=false', '2.5.29.37={critical}{text}1.3.6.1.5.5.7.3.3')

# AES-256 / SHA-256 PFX encryption instead of the legacy TripleDES-SHA1 default (CWE-327): the PFX is stored as a
# CI secret. Read it back before anything is deleted: a PFX this machine cannot read, or that holds another
# certificate, must fail here, while the key still exists.
Export-PfxCertificate -Cert $leaf -FilePath $PfxPath -Password $password -CryptoAlgorithmOption AES256_SHA256 | Out-Null
$readBack = @((Get-PfxData -FilePath $PfxPath -Password $password).EndEntityCertificates)
if ($readBack.Count -ne 1 -or $readBack[0].Thumbprint -ne $leaf.Thumbprint) {
  throw "The exported PFX does not hold exactly the new leaf ($($leaf.Thumbprint)): do not use $PfxPath."
}
Export-Certificate -Cert $leaf -FilePath $CerPath -Type CERT | Out-Null

Write-Host ''
Write-Host "pilot leaf created: $($leaf.Subject)"
Write-Host "  SHA-1 thumbprint : $($leaf.Thumbprint)   (set it as the variable POS_PILOT_LEAF_SHA1)"
Write-Host "  expires          : $($leaf.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "  PFX (secret)     : $PfxPath   (base64 it into the secret POS_PILOT_SIGN_PFX_BASE64; the password is the secret POS_PILOT_SIGN_PFX_PASSWORD)"
Write-Host "  public .cer      : $CerPath"
Write-Host ''
Write-Host 'Nothing was imported into any trust store. The leaf also stays in Cert:\CurrentUser\My on this machine,'
Write-Host 'with an exportable key: remove it once the PFX is stored safely, unless you need to export it again.'

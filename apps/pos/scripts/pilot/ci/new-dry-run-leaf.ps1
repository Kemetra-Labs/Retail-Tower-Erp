<#
.SYNOPSIS
  RT-1294 - create the EPHEMERAL pilot leaf of a dry run in Cert:\CurrentUser\My and print its thumbprint.

.DESCRIPTION
  Called by release-pilot-installer.ps1 in dry-run mode, through `powershell.exe -File` (Windows PowerShell:
  New-SelfSignedCertificate lives in its PKI module). It is a file, not an inline command, so no quoting
  or newline handling of a native argument can break it.

  The certificate has the real pilot subject so the dry run exercises the same checks as a release. It is a
  self-signed leaf (CA false, Code Signing only), valid for 2 days, with a NON-exportable key. It is untrusted
  everywhere; the calling script trusts it on that runner only and removes it with -Cleanup. This script writes
  the thumbprint, and nothing else, to the output stream.
#>
$ErrorActionPreference = 'Stop'

$leaf = New-SelfSignedCertificate -Type Custom -Subject 'CN=Kemetra POS PILOT' `
  -KeyUsage DigitalSignature `
  -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 `
  -KeyExportPolicy NonExportable -CertStoreLocation 'Cert:\CurrentUser\My' `
  -NotAfter (Get-Date).AddDays(2) `
  -TextExtension @('2.5.29.19={critical}{text}CA=false', '2.5.29.37={critical}{text}1.3.6.1.5.5.7.3.3')

Write-Output $leaf.Thumbprint

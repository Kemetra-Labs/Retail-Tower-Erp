<#
  RT-1611 test fixture: runs admit-pilot-device.ps1 -VerifyOnly (no admin, no trust store write) against small files
  signed by throwaway certificates, and prints one JSON object: case name -> "pass" or "refused: <message>".
  Every certificate it makes lives in Cert:\CurrentUser\My only, has a non-exportable key, and is deleted with its
  key at the end. Nothing is ever added to a trust store.
#>
param([Parameter(Mandatory)][string]$AdmitScript, [Parameter(Mandatory)][string]$WorkDir)

$ErrorActionPreference = 'Stop'
$made = @()

function New-TestLeaf([string]$subject, [string[]]$ext, [int]$fromDays = -1, [int]$toDays = 30) {
  $cert = New-SelfSignedCertificate -Type Custom -Subject $subject -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 -KeyExportPolicy NonExportable `
    -CertStoreLocation 'Cert:\CurrentUser\My' -NotBefore (Get-Date).AddDays($fromDays) -NotAfter (Get-Date).AddDays($toDays) `
    -TextExtension $ext
  $script:made += $cert.Thumbprint
  return $cert
}

function New-SignedFile([string]$name, $cert) {
  $path = Join-Path $WorkDir "$name.ps1"
  Set-Content -LiteralPath $path -Value "'fixture $name'" -Encoding ASCII
  Set-AuthenticodeSignature -LiteralPath $path -Certificate $cert | Out-Null
  return $path
}

function Invoke-Case([string]$file, [string]$pin, [string]$sha = $null) {
  if (-not $sha) { $sha = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash }
  try {
    & $AdmitScript -InstallerPath $file -ExpectedSha256 $sha -PinnedThumbprint $pin -VerifyOnly *> $null
    return 'pass'
  } catch {
    return "refused: $($_.Exception.Message)"
  }
}

$pilot = 'CN=Kemetra POS PILOT'
$leafOnly = '2.5.29.19={critical}{text}CA=false'
$codeSigning = '2.5.29.37={critical}{text}1.3.6.1.5.5.7.3.3'
$results = [ordered]@{}
try {
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  $good = New-TestLeaf $pilot @($leafOnly, $codeSigning)
  $other = New-TestLeaf $pilot @($leafOnly, $codeSigning)
  $ca = New-TestLeaf $pilot @('2.5.29.19={critical}{text}CA=true', $codeSigning)
  $twoPurposes = New-TestLeaf $pilot @($leafOnly, '2.5.29.37={critical}{text}1.3.6.1.5.5.7.3.3,1.3.6.1.5.5.7.3.1')
  $wrongSubject = New-TestLeaf 'CN=Kemetra POS LAB TEST' @($leafOnly, $codeSigning)
  $notYet = New-TestLeaf $pilot @($leafOnly, $codeSigning) 5 30

  $goodFile = New-SignedFile 'good' $good
  $results['good'] = Invoke-Case $goodFile $good.Thumbprint
  $results['pin in lower case with a copied U+200E mark'] = Invoke-Case $goodFile ([char]0x200E + $good.Thumbprint.ToLowerInvariant())
  $results['same subject, another key'] = Invoke-Case (New-SignedFile 'other' $other) $good.Thumbprint
  $results['wrong sha256'] = Invoke-Case $goodFile $good.Thumbprint ('0' * 64)
  $results['ca'] = Invoke-Case (New-SignedFile 'ca' $ca) $ca.Thumbprint
  $results['code signing plus server auth'] = Invoke-Case (New-SignedFile 'two' $twoPurposes) $twoPurposes.Thumbprint
  $results['wrong subject'] = Invoke-Case (New-SignedFile 'subject' $wrongSubject) $wrongSubject.Thumbprint
  $results['not valid yet'] = Invoke-Case (New-SignedFile 'notyet' $notYet) $notYet.Thumbprint
  $unsigned = Join-Path $WorkDir 'unsigned.ps1'
  Set-Content -LiteralPath $unsigned -Value "'unsigned'" -Encoding ASCII
  $results['unsigned'] = Invoke-Case $unsigned $good.Thumbprint
  $tampered = New-SignedFile 'tampered' $good
  Add-Content -LiteralPath $tampered -Value "'changed after signing'"
  $results['changed after signing'] = Invoke-Case $tampered $good.Thumbprint
  # A PE file signed by the good leaf, then one byte inside its signature block changed: Windows reads
  # UnknownError, still names the pinned signer, but the reason is not an untrusted root.
  $exe = Join-Path $WorkDir 'damaged.exe'
  Add-Type -TypeDefinition 'public static class RT1611Probe { public static void Main() { } }' -OutputAssembly $exe -OutputType ConsoleApplication
  Set-AuthenticodeSignature -LiteralPath $exe -Certificate $good | Out-Null
  $bytes = [IO.File]::ReadAllBytes($exe)
  $pe = [BitConverter]::ToInt32($bytes, 0x3C)
  $dirs = if ([BitConverter]::ToUInt16($bytes, $pe + 24) -eq 0x20b) { $pe + 24 + 112 } else { $pe + 24 + 96 }
  $secOff = [BitConverter]::ToInt32($bytes, $dirs + 32)
  $secLen = [BitConverter]::ToInt32($bytes, $dirs + 36)
  # Find a damaged byte that gives exactly the case this guards: UnknownError, still naming the pinned signer.
  $damaged = Join-Path $WorkDir 'damaged-copy.exe'
  $hit = 'none'
  # In a small file the certificate fills most of the block, so most single-byte changes alter the signer
  # instead; scan the block until one leaves the signer intact (in practice the PKCS#7 header area, ~10%).
  foreach ($step in 1..39) {
    $copy = [byte[]]$bytes.Clone()
    $i = $secOff + [int]($secLen * $step / 40)
    $copy[$i] = $copy[$i] -bxor 0x01
    [IO.File]::WriteAllBytes($damaged, $copy)
    $sig = Get-AuthenticodeSignature -LiteralPath $damaged
    if ([string]$sig.Status -eq 'UnknownError' -and $sig.SignerCertificate.Thumbprint -eq $good.Thumbprint -and
        $sig.StatusMessage.TrimEnd('.') -ne [ComponentModel.Win32Exception]::new([int]0x800B0109).Message.TrimEnd('.')) {
      $hit = 'UnknownError naming the pinned signer'
      break
    }
  }
  $results['damaged signature block: windows status'] = $hit
  $results['damaged signature block'] = Invoke-Case $damaged $good.Thumbprint
} finally {
  foreach ($t in $made) { Remove-Item -LiteralPath "Cert:\CurrentUser\My\$t" -DeleteKey -ErrorAction SilentlyContinue }
}
$results | ConvertTo-Json -Compress

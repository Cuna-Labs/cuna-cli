param(
  [Parameter(Mandatory = $true)]
  [string]$Executable,
  [Parameter(Mandatory = $true)]
  [string]$Output
)

$ErrorActionPreference = 'Stop'
$resolvedExecutable = (Resolve-Path -LiteralPath $Executable).Path
$item = Get-Item -LiteralPath $resolvedExecutable
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw 'Native bridge identity capture refuses reparse points.'
}

$signature = Get-AuthenticodeSignature -LiteralPath $resolvedExecutable
$hash = Get-FileHash -Algorithm SHA256 -LiteralPath $resolvedExecutable
$version = $item.VersionInfo
$acl = Get-Acl -LiteralPath $resolvedExecutable
$writeRights = [Security.AccessControl.FileSystemRights]::WriteData -bor
  [Security.AccessControl.FileSystemRights]::AppendData -bor
  [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
  [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
  [Security.AccessControl.FileSystemRights]::Delete -bor
  [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [Security.AccessControl.FileSystemRights]::TakeOwnership -bor
  [Security.AccessControl.FileSystemRights]::Modify -bor
  [Security.AccessControl.FileSystemRights]::FullControl
$currentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$untrustedSids = @('S-1-1-0', 'S-1-5-11', 'S-1-5-32-545', $currentUserSid)
$unsafeAcl = $false
foreach ($rule in $acl.Access) {
  $sid = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
  if (
    $untrustedSids -contains $sid -and
    $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
    (($rule.FileSystemRights -band $writeRights) -ne 0)
  ) {
    $unsafeAcl = $true
  }
}

$receipt = [ordered]@{
  schema = 'runa.native-windows-identity.v1'
  executable = $resolvedExecutable
  binarySha256 = $hash.Hash.ToLowerInvariant()
  signature = [ordered]@{
    status = $signature.Status.ToString()
    valid = $signature.Status -eq [System.Management.Automation.SignatureStatus]::Valid
    kind = 'authenticode'
    publisherCertificateFingerprint = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Thumbprint.ToUpperInvariant() }
    subject = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Subject }
    issuer = if ($null -eq $signature.SignerCertificate) { $null } else { $signature.SignerCertificate.Issuer }
  }
  version = [ordered]@{
    fileVersion = $version.FileVersion
    productVersion = $version.ProductVersion
    companyName = $version.CompanyName
    fileDescription = $version.FileDescription
    originalFilename = $version.OriginalFilename
  }
  locationProtected =
    $resolvedExecutable.StartsWith(
      ([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar),
      [StringComparison]::OrdinalIgnoreCase
    ) -and -not $unsafeAcl
  observedAt = [DateTimeOffset]::UtcNow.ToString('o')
}

$outputPath = [IO.Path]::GetFullPath($Output)
$outputDirectory = [IO.Path]::GetDirectoryName($outputPath)
if (-not [string]::IsNullOrEmpty($outputDirectory)) {
  [IO.Directory]::CreateDirectory($outputDirectory) | Out-Null
}
[IO.File]::WriteAllText($outputPath, (($receipt | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))

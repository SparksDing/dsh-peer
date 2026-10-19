# dsh-peer Windows installer.
# Run from inside the extracted dsh-peer folder:
#   powershell -ExecutionPolicy Bypass -File .\install\install-windows.ps1 -Token <hub-token>
param(
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$HubUrl = "ws://8.153.157.183:3080/dsh-peer",
    [string]$Name = $env:COMPUTERNAME,
    [string]$Cwd = $env:USERPROFILE
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($Name)) { $Name = "windows-pc" }

$source = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $env:USERPROFILE ".dsh\profiles\sdk"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$target = Join-Path $dest "dsh-peer"

if (-not [string]::Equals($source.TrimEnd('\'), $target.TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    Copy-Item -Recurse -Force $source $target
}

$yaml = @"
- insert:
    - id: peer-link
      name: ./dsh-peer/lib/index.js
      config:
        role: link
        name: $Name
        token: $Token
        connect:
          url: $HubUrl
        cwd: '$Cwd'
        provider: deepseek-official
        model: deepseek-v4-flash
"@
$patch = Join-Path $dest "cordis.patch.yml"
[IO.File]::WriteAllText($patch, $yaml)
Write-Host "installed: $dest\dsh-peer"
Write-Host "config   : $patch"
Write-Host ""
Write-Host "start the link in a terminal and keep it open:"
Write-Host "  dsh --profile sdk"

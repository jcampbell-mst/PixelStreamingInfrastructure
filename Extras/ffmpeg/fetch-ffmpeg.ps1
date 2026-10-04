<#
.SYNOPSIS
    Downloads the static ffmpeg build used by the SFU snapshot subsystem.

.DESCRIPTION
    Fetches the LGPL static Windows x64 build from BtbN/FFmpeg-Builds and places
    ffmpeg.exe and its licence text in win64-x64/. The LGPL variant is used on
    purpose: a GPL build would put the whole distribution under the GPL.
#>
[CmdletBinding()]
param(
    [string] $Destination,
    [switch] $Force
)

$ErrorActionPreference = 'Stop'

if (-not $Destination) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
    $Destination = Join-Path $scriptDir 'win64-x64'
}

$assetName = 'ffmpeg-master-latest-win64-lgpl.zip'
$url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/$assetName"
$target = Join-Path $Destination 'ffmpeg.exe'
$targetLicense = Join-Path $Destination 'LICENSE.txt'

if ((Test-Path $target) -and -not $Force) {
    Write-Host "ffmpeg already present at $target. Use -Force to replace it."
    exit 0
}

$workDir = Join-Path ([System.IO.Path]::GetTempPath()) ("ffmpeg-fetch-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $workDir | Out-Null

try {
    $archive = Join-Path $workDir $assetName
    Write-Host "Downloading $url"
    Invoke-WebRequest -Uri $url -OutFile $archive -UseBasicParsing

    Write-Host 'Extracting'
    Expand-Archive -Path $archive -DestinationPath $workDir -Force

    $root = Get-ChildItem -Path $workDir -Directory | Select-Object -First 1
    if (-not $root) {
        throw "The archive did not contain the expected folder."
    }

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Copy-Item (Join-Path $root.FullName 'bin\ffmpeg.exe') $target -Force
    Copy-Item (Join-Path $root.FullName 'LICENSE.txt') $targetLicense -Force

    Write-Host "Installed $target"
    & $target -hide_banner -version | Select-Object -First 1
} finally {
    Remove-Item $workDir -Recurse -Force -ErrorAction SilentlyContinue
}

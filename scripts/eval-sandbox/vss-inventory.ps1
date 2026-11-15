<#
.SYNOPSIS
  R4b Step 1D: READ-ONLY inventory of the shadow copies that could hold this repo. Run in an ELEVATED
  Windows PowerShell (Win32_ShadowCopy and vssadmin need it) and paste the output back for review.

.DESCRIPTION
  Lists every shadow copy twice, independently (Win32_ShadowCopy and vssadmin list shadows), so an
  empty list can be told apart from a failed one, and records the repo volume's GUID. For each copy of
  that volume it only checks whether two fixed paths exist in the copy, the repo folder and the public
  control file package.json, and reads their security descriptors. It never lists a folder, never opens
  a file's data, never touches evals\, truths, saved runs or credentials, and never creates, deletes,
  mounts, resizes or changes a shadow copy, a restore point, a service, a setting or an ACL. It writes
  no file and sends nothing anywhere. The last line is the inventory as one JSON object prefixed with
  TD-VSS-INVENTORY (src/eval/sandbox/shadow.ts validates it). A failed query stops the script before
  that line, so a missing line means no inventory.
#>
[CmdletBinding()]
param()
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this in an elevated PowerShell.' }

# The repo root from this script's own location, drive letter upper-case; the paths checked inside each copy.
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
if ($repoRoot -notmatch '^([A-Za-z]):\\(.+)$') { throw "Unexpected repo root $repoRoot" }
$drive = "$($Matches[1].ToUpperInvariant()):"
$repoRoot = "$drive\$($Matches[2])"
$repoRel = $Matches[2]
$controlRel = "$repoRel\package.json"
$Vssadmin = Join-Path $env:SystemRoot 'System32\vssadmin.exe'

$volumes = @(Get-CimInstance Win32_Volume -ErrorAction Stop)
$letters = @{}
foreach ($v in $volumes) { if ($v.DriveLetter) { $letters[$v.DeviceID] = $v.DriveLetter.ToUpperInvariant() } }
$repoVolume = @($volumes | Where-Object { $_.DriveLetter -and $_.DriveLetter.ToUpperInvariant() -eq $drive })
if ($repoVolume.Count -ne 1) { throw "Expected exactly one volume with drive letter $drive, found $($repoVolume.Count)." }
$repoVolumeName = "$($repoVolume[0].DeviceID)"

# Enumeration 1: vssadmin (its own output is shown as-is). Its exit code and IDs are recorded, not trusted alone.
'== vssadmin list shadows'
$ErrorActionPreference = 'Continue'
$vssOut = @(& $Vssadmin list shadows 2>&1 | ForEach-Object { "$_" })
$vssExit = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
$vssOut
$vssIds = @($vssOut | Where-Object { $_ -match 'Shadow Copy ID:' } | ForEach-Object { if ($_ -match '\{[0-9A-Fa-f-]{36}\}') { $Matches[0].ToLowerInvariant() } })
$vssNoItems = [bool]($vssOut | Where-Object { $_ -match 'No items found that satisfy the query' })
'== vssadmin list shadowstorage'
$ErrorActionPreference = 'Continue'
& $Vssadmin list shadowstorage 2>&1 | ForEach-Object { "$_" }
$ErrorActionPreference = 'Stop'

function Get-PathFact([string]$Device, [string]$Rel) {
  # .NET calls, because the PowerShell 5.1 providers don't handle \\?\GLOBALROOT paths reliably.
  $p = "$Device\$Rel"
  $fact = [ordered]@{ path = $Rel; exists = $null; sddl = $null }
  try {
    $isDir = [IO.Directory]::Exists($p)
    $isFile = (-not $isDir) -and [IO.File]::Exists($p)
    $fact.exists = $isDir -or $isFile
    if ($isDir) { $fact.sddl = [IO.Directory]::GetAccessControl($p, 'Access').GetSecurityDescriptorSddlForm('Access') }
    elseif ($isFile) { $fact.sddl = [IO.File]::GetAccessControl($p, 'Access').GetSecurityDescriptorSddlForm('Access') }
  } catch { $fact.exists = $null; $fact.sddl = $null }
  $fact
}

# Enumeration 2: Win32_ShadowCopy. A failing query stops the script (no inventory line).
'== Win32_ShadowCopy'
$wmi = @(Get-CimInstance Win32_ShadowCopy -ErrorAction Stop | Sort-Object InstallDate)
$copies = @()
foreach ($c in $wmi) {
  $volume = if ($letters.ContainsKey("$($c.VolumeName)")) { $letters["$($c.VolumeName)"] } else { $null }
  $copy = [ordered]@{
    id         = "$($c.ID)"
    createdAt  = $c.InstallDate.ToUniversalTime().ToString('o')
    volume     = $volume
    volumeName = "$($c.VolumeName)"
    device     = "$($c.DeviceObject)"
    repo       = [ordered]@{ path = $repoRel; exists = $null; sddl = $null }
    control    = [ordered]@{ path = $controlRel; exists = $null; sddl = $null }
  }
  if ($copy.volumeName -eq $repoVolumeName -and $copy.device -match '^\\\\\?\\GLOBALROOT\\Device\\HarddiskVolumeShadowCopy[1-9][0-9]{0,5}$') {
    $copy.repo = Get-PathFact $copy.device $repoRel
    $copy.control = Get-PathFact $copy.device $controlRel
  }
  "id: $($copy.id)  created: $($copy.createdAt)  volume: $($copy.volume)  device: $($copy.device)"
  "  repo exists: $($copy.repo.exists)  sddl: $($copy.repo.sddl)"
  "  control exists: $($copy.control.exists)  sddl: $($copy.control.sddl)"
  $copies += , $copy
}
"count: $($copies.Count) (vssadmin: $($vssIds.Count), exit $vssExit)"

$inventory = [ordered]@{
  schema         = 2
  computer       = $env:COMPUTERNAME
  collectedAt    = (Get-Date).ToUniversalTime().ToString('o')
  repoRoot       = $repoRoot
  repoVolumeName = $repoVolumeName
  enumeration    = [ordered]@{ wmiCount = $wmi.Count; vssadminExitCode = $vssExit; vssadminIds = $vssIds; vssadminNoItems = $vssNoItems }
  copies         = $copies
}
'TD-VSS-INVENTORY ' + (ConvertTo-Json -InputObject $inventory -Depth 5 -Compress)

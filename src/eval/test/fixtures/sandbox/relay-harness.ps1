#Requires -Version 5.1
# TEST ONLY (src/eval/test/sandbox-relay.test.ts): compiles scripts/eval-sandbox/TdSandboxRelay.cs
# exactly as launch-as.ps1 does and runs it against a child started AS THE CURRENT USER (no
# UserName, no Password, no credential). It never starts anything under another identity.
param(
  [Parameter(Mandatory = $true)][string]$Node,
  [Parameter(Mandatory = $true)][string]$Script,
  [string]$Arguments = ''
)
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

Add-Type -Path (Join-Path $PSScriptRoot '..\..\..\..\..\scripts\eval-sandbox\TdSandboxRelay.cs')

$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $Node
$info.Arguments = "`"$Script`" $Arguments"
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
[Console]::Error.WriteLine("relay-harness: pid $PID")
exit ([TdSandboxRelay]::Run($info))

#Requires -Version 5.1
<#
.SYNOPSIS
  Starts runtime\bin\stage2.mjs as the evaluation account and relays stdin, stdout and stderr (R4b Step 1D).

.DESCRIPTION
  Called only by src/eval/sandbox/launcher.ts, never by hand. The request comes from the
  TD_LAUNCH_REQUEST environment variable (JSON, no secrets) and is re-validated here:
  - the executable is always "$env:ProgramFiles\nodejs\node.exe";
  - the only script is <runtime>\bin\stage2.mjs, the only other argument a base64 header;
  - the credential is always "$env:LOCALAPPDATA\test-detective\eval-account.xml" (DPAPI, readable
    only by the developer), and its user name must be exactly COMPUTER\account.
  The child is started through CreateProcessWithLogonW (System.Diagnostics.Process with UserName)
  with the account's own profile environment, never the developer's, and never falls back to the
  developer's identity: if the logon fails, nothing starts. The child is placed in a job object
  that kills its whole tree when this launcher exits or is killed (TdSandboxRelay.cs); stage2
  starts nothing until the relay confirms the job assignment on its stdin.

  The password is never written to the command line, the environment, stdout, stderr or a file.

.NOTES
  Exit codes: the child's, or 90 invalid request, 91 credential problem, 92 start failed,
  96 the child could not be contained in a job object (it was killed).
#>
Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

function Stop-Launch([string]$Message, [int]$Code) {
  [Console]::Error.WriteLine("launch-as: $Message")
  exit $Code
}

$raw = $env:TD_LAUNCH_REQUEST
if (-not $raw) { Stop-Launch 'TD_LAUNCH_REQUEST is not set.' 90 }
try { $request = $raw | ConvertFrom-Json } catch { Stop-Launch 'TD_LAUNCH_REQUEST is not valid JSON.' 90 }
Remove-Item Env:\TD_LAUNCH_REQUEST
foreach ($key in 'account', 'node', 'credentialFile', 'runtime', 'cwd', 'header') {
  if ($request.PSObject.Properties.Name -notcontains $key -or $request.$key -isnot [string]) { Stop-Launch "TD_LAUNCH_REQUEST.$key must be a string." 90 }
}

$computer = $env:COMPUTERNAME
$expectedNode = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$expectedCredential = Join-Path $env:LOCALAPPDATA 'test-detective\eval-account.xml'
$drivePath = '^[A-Za-z]:\\[^\\<>:"|?*]+(\\[^\\<>:"|?*]+)*$'

if ($request.account -notmatch '^[A-Za-z][A-Za-z0-9-]{1,19}$') { Stop-Launch 'Invalid account name.' 90 }
if ($request.account -eq $env:USERNAME) { Stop-Launch 'The evaluation account cannot be the current user.' 90 }
if ($request.node -ne $expectedNode) { Stop-Launch "Only $expectedNode may be started." 90 }
if ($request.credentialFile -ne $expectedCredential) { Stop-Launch 'Unexpected credential file.' 90 }
if ($request.runtime -notmatch $drivePath -or $request.cwd -notmatch $drivePath) { Stop-Launch 'Runtime and cwd must be absolute drive paths.' 90 }
# Normalized paths only (no '.', '..', doubled or trailing separators): the runtime is <root>\runtime
# and the working directory lies under the sibling <root>\work\.
foreach ($p in $request.runtime, $request.cwd) {
  if ([System.IO.Path]::GetFullPath($p) -cne $p -or $p -match '\\\.\.?(\\|$)') { Stop-Launch 'Runtime and cwd must be normalized absolute paths.' 90 }
}
if ((Split-Path -Leaf $request.runtime) -ne 'runtime') { Stop-Launch 'The runtime folder must be <sandbox root>\runtime.' 90 }
$workRoot = Join-Path (Split-Path -Parent $request.runtime) 'work'
if (-not $request.cwd.StartsWith("$workRoot\", [System.StringComparison]::OrdinalIgnoreCase)) { Stop-Launch 'The working directory must be inside <sandbox root>\work.' 90 }
$stage2 = Join-Path $request.runtime 'bin\stage2.mjs'
if (-not (Test-Path -LiteralPath $stage2 -PathType Leaf)) { Stop-Launch 'stage2.mjs not found in the runtime.' 90 }
if (-not (Test-Path -LiteralPath $request.cwd -PathType Container)) { Stop-Launch 'The working directory does not exist.' 90 }
foreach ($p in $request.runtime, (Join-Path $request.runtime 'bin'), $stage2, $workRoot, $request.cwd) {
  if ((Get-Item -LiteralPath $p -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { Stop-Launch 'The runtime and the working directory must not be links.' 90 }
}
if ($request.header -notmatch '^[A-Za-z0-9+/]+={0,2}$' -or $request.header.Length -gt 24000) { Stop-Launch 'The stage2 header must be base64 (at most 24000 characters).' 90 }

if (-not (Test-Path -LiteralPath $expectedCredential -PathType Leaf)) { Stop-Launch 'No stored evaluation credential; run scripts/eval-sandbox/setup.ps1 first.' 91 }
try { $credential = Import-Clixml -LiteralPath $expectedCredential } catch { Stop-Launch 'The stored credential cannot be decrypted by this user.' 91 }
if ($credential -isnot [System.Management.Automation.PSCredential] -or $credential.UserName -ne "$computer\$($request.account)") { Stop-Launch 'The stored credential is for a different account.' 91 }

Add-Type -Path (Join-Path $PSScriptRoot 'TdSandboxRelay.cs')

$info = New-Object System.Diagnostics.ProcessStartInfo
$info.FileName = $expectedNode
# Both parts were validated above: a path without quotes and a base64 string.
$info.Arguments = "`"$stage2`" $($request.header)"
$info.WorkingDirectory = $request.cwd
$info.UserName = $request.account
$info.Domain = $computer
$info.Password = $credential.Password
$info.LoadUserProfile = $true
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
# EnvironmentVariables is deliberately never touched: left unset, CreateProcessWithLogonW builds the
# environment from the account's own profile instead of copying this (developer) process's.

try { $code = [TdSandboxRelay]::Run($info) } catch {
  $reason = $_.Exception
  while ($reason.InnerException) { $reason = $reason.InnerException }
  Stop-Launch "Could not start the evaluation process as $($request.account): $($reason.Message)" 92
}
exit $code

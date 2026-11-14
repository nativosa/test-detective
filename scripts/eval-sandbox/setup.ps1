#Requires -Version 5.1
<#
.SYNOPSIS
  Plans, applies, verifies or removes the OS-enforced evaluation sandbox (R4b Step 1D).

.DESCRIPTION
  Default (no switch): read-only. Collects an inventory of the evaluation account and group, the
  ACLs of the deny root (default: the repo's top-level folder, e.g. C:\GIT) and of every item below
  it, the developer's private folders, the sandbox folders and this script's own journal, and
  prints every change -Apply would make, with the plan's SHA-256. The decisions are made by
  src/eval/sandbox/setup-plan.ts (unit-tested), run through the minimal entry point setup-cli.ts;
  this script only collects facts and executes the planned actions through fixed functions.

  -Apply -PlanSha256 <hash>   Executes exactly the reviewed plan (refuses if the hash differs or a
                              blocker exists). Creating the account and group needs an elevated shell.
  -Remove -PlanSha256 <hash>  Rolls back only what the journal records this script created.
  -Verify                     Read-only checks of the applied state. Exit 0 when all pass.
  -InventoryOnly              Read-only: prints the inventory JSON (for review and tests).
  -WhatIf                     With -Apply or -Remove: describes every change and makes none.
  -Json                       Prints the plan or report as JSON only.

  The credential, the journal and the observed token always live in
  %LOCALAPPDATA%\test-detective\ under fixed names; no other destination is accepted, and a link
  there is refused. Every change is journaled as pending before it starts and confirmed after it,
  with atomic writes, so an interrupted run is reconciled (exact identities only) or rolled back.

  Never prints or logs the password. Never touches shadow copies, system-wide security policy,
  other accounts, or ACEs it did not add.

.NOTES
  Exit codes: 0 done / nothing blocked / verification passed, 1 refused or error, 2 blocked or
  verification failed.
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'High')]
param(
  [switch]$Apply,
  [switch]$Remove,
  [switch]$Verify,
  [switch]$InventoryOnly,
  [string]$PlanSha256,
  [switch]$Json,
  [string]$Account = 'td-eval',
  [string]$Group = 'td-eval-sandbox',
  [string]$SandboxRoot = 'C:\td-eval',
  [string]$DenyRoot
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'

$Marker = 'test-detective evaluation sandbox (R4b)'
$NamePattern = '^[A-Za-z][A-Za-z0-9-]{1,19}$'
$DrivePath = '^[A-Za-z]:\\[^\\<>:"|?*]+(\\[^\\<>:"|?*]+)*$'
$RepoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).ProviderPath
$Node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$Cli = Join-Path $RepoRoot 'src\eval\sandbox\setup-cli.ts'
$Computer = $env:COMPUTERNAME

function Stop-Setup([string]$Message, [int]$Code = 1) {
  [Console]::Error.WriteLine("setup.ps1: $Message")
  exit $Code
}

# ---------------------------------------------------------------------------
# Arguments

$modes = @(@($Apply, $Remove, $Verify, $InventoryOnly) | Where-Object { $_ })
if ($modes.Count -gt 1) { Stop-Setup 'Use at most one of -Apply, -Remove, -Verify and -InventoryOnly.' }
$Mode = if ($Apply) { 'apply' } elseif ($Remove) { 'remove' } elseif ($Verify) { 'verify' } elseif ($InventoryOnly) { 'inventory' } else { 'plan' }
if ($WhatIfPreference -and $Mode -notin 'apply', 'remove') { Stop-Setup '-WhatIf applies to -Apply and -Remove; the other modes never change anything.' }
foreach ($n in $Account, $Group) { if ($n -notmatch $NamePattern) { Stop-Setup "Invalid account or group name: $n" } }
if ($Account -eq $Group) { Stop-Setup 'The account and the group need different names.' }
if (-not $DenyRoot) {
  if ($RepoRoot -notmatch '^([A-Za-z]:)\\([^\\]+)') { Stop-Setup "Cannot derive the deny root from $RepoRoot" }
  $DenyRoot = "$($Matches[1].ToUpper())\$($Matches[2])"
}
if (-not $env:LOCALAPPDATA) { Stop-Setup 'LOCALAPPDATA is not set.' }
# The application-private folder: fixed file names, never a parameter (no arbitrary destinations).
$SecretDir = Join-Path $env:LOCALAPPDATA 'test-detective'
$CredentialFile = Join-Path $SecretDir 'eval-account.xml'
$StateFile = Join-Path $SecretDir 'eval-sandbox-state.json'
$TokenFile = Join-Path $SecretDir 'eval-token.json'
foreach ($p in $SandboxRoot, $DenyRoot, $SecretDir) { if ($p -notmatch $DrivePath) { Stop-Setup "Not an absolute drive path: $p" } }
foreach ($p in $SecretDir, $CredentialFile, $StateFile, "$StateFile.tmp", $TokenFile) {
  $existing = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
  if ($existing -and ($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { Stop-Setup "$p is a link; refusing to read or write through it." }
}
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { Stop-Setup "Node not found at $Node" }

# ---------------------------------------------------------------------------
# Read-only inventory

function ConvertTo-Rights([int]$Value) { [BitConverter]::ToUInt32([BitConverter]::GetBytes($Value), 0) }

$script:SidNames = @{}
function Get-SidName([string]$Sid) {
  if (-not $script:SidNames.ContainsKey($Sid)) {
    $name = $Sid
    try { $name = (New-Object System.Security.Principal.SecurityIdentifier $Sid).Translate([System.Security.Principal.NTAccount]).Value } catch { }
    $script:SidNames[$Sid] = $name
  }
  $script:SidNames[$Sid]
}

function ConvertTo-AceRecord($Rule) {
  $sid = $Rule.IdentityReference.Value
  [ordered]@{
    identity    = Get-SidName $sid
    sid         = $sid
    type        = "$($Rule.AccessControlType)"
    rights      = ConvertTo-Rights ([int]$Rule.FileSystemRights)
    inherited   = [bool]$Rule.IsInherited
    inheritance = [int]$Rule.InheritanceFlags
    propagation = [int]$Rule.PropagationFlags
  }
}

function Get-AceList($Acl) {
  $list = New-Object System.Collections.Generic.List[object]
  foreach ($r in $Acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) { $list.Add((ConvertTo-AceRecord $r)) }
  , $list.ToArray()
}

function Get-PathInventory([string]$Path) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if (-not $item) { return [ordered]@{ path = $Path; exists = $false; owner = $null; ownerSid = $null; protected = $null; aces = @() } }
  $acl = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]'Access, Owner')
  $owner = $null
  $ownerSid = $null
  try { $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; $owner = Get-SidName $ownerSid } catch { }
  [ordered]@{ path = $Path; exists = $true; owner = $owner; ownerSid = $ownerSid; protected = [bool]$acl.AreAccessRulesProtected; aces = (Get-AceList $acl) }
}

function Get-MemberSids([string]$GroupName) {
  $sids = New-Object System.Collections.Generic.List[string]
  $adsi = [ADSI]"WinNT://$Computer/$GroupName,group"
  foreach ($m in @($adsi.psbase.Invoke('Members'))) {
    $bytes = $m.GetType().InvokeMember('objectSid', 'GetProperty', $null, $m, $null)
    $sids.Add((New-Object System.Security.Principal.SecurityIdentifier($bytes, 0)).Value)
  }
  , $sids.ToArray()
}

function Get-GroupNameBySid([string]$Sid) {
  (New-Object System.Security.Principal.SecurityIdentifier $Sid).Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
}

function Get-PrincipalInventory([string]$Name, [string]$Kind, [string]$GroupSid) {
  $obj = if ($Kind -eq 'user') { Get-LocalUser -Name $Name -ErrorAction SilentlyContinue } else { Get-LocalGroup -Name $Name -ErrorAction SilentlyContinue }
  if (-not $obj) { return [ordered]@{ name = $Name; exists = $false; sid = $null; description = $null; memberships = @(); enabled = $null; profilePath = $null } }
  $sid = $obj.SID.Value
  $memberships = New-Object System.Collections.Generic.List[string]
  $profilePath = $null
  $enabled = $null
  if ($Kind -eq 'user') {
    $enabled = [bool]$obj.Enabled
    $groups = @('S-1-5-32-544', 'S-1-5-32-545')
    if ($GroupSid) { $groups += $GroupSid }
    foreach ($g in $groups) { if ((Get-MemberSids (Get-GroupNameBySid $g)) -contains $sid) { $memberships.Add($g) } }
    $userProfile = Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue
    if ($userProfile) { $profilePath = $userProfile.LocalPath }
  } else {
    foreach ($m in (Get-MemberSids $Name)) { $memberships.Add($m) }
  }
  [ordered]@{ name = $obj.Name; exists = $true; sid = $sid; description = $obj.Description; memberships = $memberships.ToArray(); enabled = $enabled; profilePath = $profilePath }
}

# Groups every item below $Root by its ACL as it matters for the evaluation account (folder or file,
# protected or not, an untrusted owner, all ACEs of untrusted principals), counting each item in
# exactly one shape. Never follows links (they are listed), counts every unreadable item as an
# error, and marks the scan truncated when there are more distinct shapes than it keeps.
function Get-AclShapes([string]$Root, [string[]]$TrustedSids, [int]$ShapeLimit = 400, [int]$TopLimit = 200) {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
    return [ordered]@{ root = $Root; scanned = 0; topLevel = @(); topLevelTruncated = $false; shapes = @(); truncated = $false; reparsePoints = @(); errors = 0 }
  }
  $byKey = @{}
  $shapes = New-Object System.Collections.Generic.List[object]
  $reparse = New-Object System.Collections.Generic.List[object]
  $top = New-Object System.Collections.Generic.List[string]
  $scanned = 0; $errors = 0; $truncated = $false; $topTruncated = $false
  $sections = [System.Security.AccessControl.AccessControlSections]'Access, Owner'
  $sidType = [System.Security.Principal.SecurityIdentifier]
  $stack = New-Object System.Collections.Generic.Stack[object]
  $stack.Push(@((New-Object System.IO.DirectoryInfo ("\\?\" + $Root)), $true))
  while ($stack.Count -gt 0) {
    $frame = $stack.Pop()
    try { $entries = $frame[0].GetFileSystemInfos() } catch { $errors++; continue }
    foreach ($e in $entries) {
      $scanned++
      $display = $e.FullName.Substring(4)
      if ($frame[1]) { if ($top.Count -lt $TopLimit) { $top.Add($e.Name) } else { $topTruncated = $true } }
      if ($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        $target = $null
        try { $target = @((Get-Item -LiteralPath $display -Force).Target)[0] } catch { }
        if ($reparse.Count -lt 200) { $reparse.Add([ordered]@{ path = $display; target = $target }) }
        continue
      }
      try {
        $acl = $e.GetAccessControl($sections)
        $owner = $acl.GetOwner($sidType).Value
        $rules = @($acl.GetAccessRules($true, $true, $sidType))
      } catch { $errors++; continue }
      if ($TrustedSids -contains $owner) { $owner = $null }
      $kept = New-Object System.Collections.Generic.List[object]
      $parts = New-Object System.Collections.Generic.List[string]
      foreach ($r in $rules) {
        if ($TrustedSids -contains $r.IdentityReference.Value) { continue }
        $kept.Add($r)
        $parts.Add("$($r.IdentityReference.Value)/$($r.AccessControlType)/$([int]$r.FileSystemRights)/$($r.IsInherited)/$([int]$r.InheritanceFlags)/$([int]$r.PropagationFlags)")
      }
      $container = $e -is [System.IO.DirectoryInfo]
      $key = "$container|$($acl.AreAccessRulesProtected)|$owner|$($parts -join ';')"
      $shape = $byKey[$key]
      if ($null -eq $shape) {
        if ($shapes.Count -ge $ShapeLimit) { $truncated = $true } else {
          $aces = New-Object System.Collections.Generic.List[object]
          foreach ($r in $kept) { $aces.Add((ConvertTo-AceRecord $r)) }
          $shape = [ordered]@{ container = $container; protected = [bool]$acl.AreAccessRulesProtected; owner = $owner; aces = $aces.ToArray(); count = 0; samples = (New-Object System.Collections.Generic.List[string]) }
          $byKey[$key] = $shape
          $shapes.Add($shape)
        }
      }
      if ($null -ne $shape) {
        $shape.count++
        if ($shape.samples.Count -lt 3) { $shape.samples.Add($display) }
      }
      if ($container) { $stack.Push(@($e, $false)) }
    }
  }
  foreach ($s in $shapes) { $s.samples = $s.samples.ToArray() }
  [ordered]@{ root = $Root; scanned = $scanned; topLevel = $top.ToArray(); topLevelTruncated = $topTruncated; shapes = $shapes.ToArray(); truncated = $truncated; reparsePoints = $reparse.ToArray(); errors = $errors }
}

# Counts links under a folder without following any (Get-ChildItem -Recurse may follow junctions in 5.1).
function Get-ReparseCount([string]$Root) {
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return 0 }
  $count = 0
  $stack = New-Object System.Collections.Generic.Stack[System.IO.DirectoryInfo]
  $stack.Push((New-Object System.IO.DirectoryInfo ("\\?\" + $Root)))
  while ($stack.Count -gt 0) {
    foreach ($e in $stack.Pop().GetFileSystemInfos()) {
      if ($e.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { $count++ } elseif ($e -is [System.IO.DirectoryInfo]) { $stack.Push($e) }
    }
  }
  $count
}

function Get-Inventory {
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $elevated = (New-Object System.Security.Principal.WindowsPrincipal $me).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
  $groupInfo = Get-PrincipalInventory $Group 'group' $null
  $accountInfo = Get-PrincipalInventory $Account 'user' $groupInfo.sid
  $trusted = @('S-1-5-18', 'S-1-5-32-544', 'S-1-3-0', $me.User.Value)
  $recorded = $null
  if (Test-Path -LiteralPath $StateFile -PathType Leaf) { $recorded = Get-Content -LiteralPath $StateFile -Raw -Encoding UTF8 | ConvertFrom-Json }
  # Only the user name is read from the stored credential; the password is never touched.
  $credentialUser = $null
  if (Test-Path -LiteralPath $CredentialFile -PathType Leaf) {
    try {
      $stored = Import-Clixml -LiteralPath $CredentialFile
      if ($stored -is [System.Management.Automation.PSCredential]) { $credentialUser = $stored.UserName }
    } catch { }
    $stored = $null
  }
  $tokenJson = $null
  # A plain string: Get-Content's result carries provider properties that ConvertTo-Json would serialize.
  if (Test-Path -LiteralPath $TokenFile -PathType Leaf) { $tokenJson = [System.IO.File]::ReadAllText($TokenFile, [System.Text.Encoding]::UTF8) }
  $temp = [System.IO.Path]::GetTempPath().TrimEnd('\')
  $private = New-Object System.Collections.Generic.List[object]
  foreach ($p in @($env:USERPROFILE, (Join-Path $env:USERPROFILE '.claude'), $env:LOCALAPPDATA, $temp) | Select-Object -Unique) { $private.Add((Get-PathInventory $p)) }
  $runtime = Join-Path $SandboxRoot 'runtime'
  [ordered]@{
    schema               = 2
    computer             = $Computer
    developer            = [ordered]@{ name = $me.Name; sid = $me.User.Value; profile = $env:USERPROFILE }
    elevated             = $elevated
    config               = [ordered]@{ account = $Account; group = $Group; root = $SandboxRoot; denyRoot = $DenyRoot; credentialFile = $CredentialFile; stateFile = $StateFile; tokenFile = $TokenFile }
    account              = $accountInfo
    group                = $groupInfo
    nameCollisions       = [ordered]@{ accountIsGroup = [bool](Get-LocalGroup -Name $Account -ErrorAction SilentlyContinue); groupIsUser = [bool](Get-LocalUser -Name $Group -ErrorAction SilentlyContinue) }
    denyRoot             = Get-PathInventory $DenyRoot
    childScan            = Get-AclShapes $DenyRoot $trusted
    privateRoots         = $private.ToArray()
    sandbox              = [ordered]@{
      root          = Get-PathInventory $SandboxRoot
      runtime       = Get-PathInventory $runtime
      work          = Get-PathInventory (Join-Path $SandboxRoot 'work')
      reparsePoints = Get-ReparseCount $SandboxRoot
      runtimeScan   = Get-AclShapes $runtime $trusted
    }
    credentialFileExists = Test-Path -LiteralPath $CredentialFile -PathType Leaf
    credentialUserName   = $credentialUser
    tokenFileExists      = Test-Path -LiteralPath $TokenFile -PathType Leaf
    observedTokenJson    = $tokenJson
    state                = $recorded
  }
}

# The planner (src/eval/sandbox/setup-cli.ts, which imports only setup-plan.ts and config.ts) reads
# the inventory as JSON on stdin; nothing from it is ever evaluated as code here.
function Invoke-Planner($Inventory, [string]$Kind) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $Node
  $psi.Arguments = "`"$Cli`" $Kind"
  $psi.UseShellExecute = $false
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.StandardOutputEncoding = New-Object System.Text.UTF8Encoding $false
  $proc = [System.Diagnostics.Process]::Start($psi)
  $writer = New-Object System.IO.StreamWriter($proc.StandardInput.BaseStream, (New-Object System.Text.UTF8Encoding $false))
  $writer.Write(($Inventory | ConvertTo-Json -Depth 12 -Compress))
  $writer.Close()
  $out = $proc.StandardOutput.ReadToEnd()
  $err = $proc.StandardError.ReadToEnd()
  $proc.WaitForExit()
  if ($proc.ExitCode -ne 0) { Stop-Setup "The planner failed: $err" }
  $out | ConvertFrom-Json
}

# ---------------------------------------------------------------------------
# Changes. Only reached from the ShouldProcess-gated loop below, after the plan hash was confirmed.

# Atomic: the journal is written to a temporary file and swapped in, so an interruption leaves
# either the previous or the new journal, never a partial one.
function Save-State($State) {
  if (-not (Test-Path -LiteralPath $SecretDir -PathType Container)) { New-Item -ItemType Directory -Path $SecretDir | Out-Null }
  $tmp = "$StateFile.tmp"
  [System.IO.File]::WriteAllText($tmp, ($State | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding $false))
  if (Test-Path -LiteralPath $StateFile -PathType Leaf) { [System.IO.File]::Replace($tmp, $StateFile, $null) } else { [System.IO.File]::Move($tmp, $StateFile) }
}

function New-RandomPassword {
  $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%+-=?@_'
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $secure = New-Object System.Security.SecureString
  foreach ($b in $bytes) { $secure.AppendChar($alphabet[$b % $alphabet.Length]) }
  foreach ($c in 'K', 'k', '7', '#') { $secure.AppendChar($c) }
  [Array]::Clear($bytes, 0, $bytes.Length)
  $rng.Dispose()
  $secure.MakeReadOnly()
  $secure
}

# Six hex digits written into a new principal's description and journaled before it is created,
# so an interrupted run can recognize exactly the object it created.
function New-Nonce {
  $bytes = New-Object byte[] 3
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''
}

# Users (fixed SID) or the group this script recorded; never any other group.
function Resolve-GroupSid([string]$Ref, $State) {
  if ($Ref -eq 'S-1-5-32-545') { return $Ref }
  if (-not $State.group) { throw 'No group is recorded.' }
  if ($Ref -ne $State.group.sid -and $Ref -ne "$Computer\$Group") { throw "Unexpected group reference $Ref" }
  $sid = (Get-LocalGroup -Name $Group).SID.Value
  if ($sid -ne $State.group.sid) { throw "$Group is not the recorded group." }
  $sid
}

function New-FolderSecurity([bool]$GrantGroupRead, $State) {
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $none = [System.Security.AccessControl.PropagationFlags]::None
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  foreach ($sid in @((New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-18'), (New-Object System.Security.Principal.SecurityIdentifier 'S-1-5-32-544'), $me)) {
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, $none, 'Allow')))
  }
  if ($GrantGroupRead) {
    $groupSid = New-Object System.Security.Principal.SecurityIdentifier (Resolve-GroupSid "$Computer\$Group" $State)
    $security.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($groupSid, 'ReadAndExecute', $inherit, $none, 'Allow')))
  }
  $security
}

# A folder created by this script: protected, only explicit ACEs.
function Test-FolderAcl([string]$Path) {
  $acl = (Get-Item -LiteralPath $Path -Force).GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
  $acl.AreAccessRulesProtected -and @($acl.GetAccessRules($false, $true, [System.Security.Principal.SecurityIdentifier])).Count -eq 0
}

# Whether the deny root carries exactly the recorded explicit Deny ACE.
function Test-DenyAce($Record) {
  $acl = (Get-Item -LiteralPath $DenyRoot -Force).GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
  foreach ($r in $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) {
    if ("$($r.AccessControlType)" -eq 'Deny' -and $r.IdentityReference.Value -eq $Record.sid -and (ConvertTo-Rights ([int]$r.FileSystemRights)) -eq [uint32]$Record.rights -and [int]$r.InheritanceFlags -eq $Record.inheritance -and [int]$r.PropagationFlags -eq $Record.propagation) { return $true }
  }
  $false
}

# Reconciles the interrupted operation the planner identified, re-checking the exact identity first.
# Only changes the journal in memory; the caller saves it.
function Resolve-Pending($Action, $State) {
  if ($Action.resolution -eq 'discard') { return }
  if ($Action.resolution -ne 'adopt') { throw "Unknown resolution $($Action.resolution)" }
  $p = $State.pending
  if (-not $p -or $p.kind -ne $Action.pendingKind -or $p.target -ne $Action.target) { throw 'The journal changed since planning.' }
  switch ($Action.pendingKind) {
    'create-group' {
      $g = Get-LocalGroup -SID $Action.sid
      if ($p.nonce -ne $Action.nonce -or $g.Description -ne "$Marker #$($Action.nonce)" -or $g.Name -ne $Group) { throw 'The group does not carry the journaled marker.' }
      $State.group = [ordered]@{ name = $Group; sid = $Action.sid; nonce = $Action.nonce }
    }
    'create-user' {
      $u = Get-LocalUser -SID $Action.sid
      if ($p.nonce -ne $Action.nonce -or $u.Description -ne "$Marker #$($Action.nonce)" -or $u.Name -ne $Account) { throw 'The account does not carry the journaled marker.' }
      $State.account = [ordered]@{ name = $Account; sid = $Action.sid; nonce = $Action.nonce }
      if (Test-Path -LiteralPath $CredentialFile -PathType Leaf) {
        if ($Mode -eq 'apply' -and (Import-Clixml -LiteralPath $CredentialFile).UserName -ne "$Computer\$Account") { throw 'The stored credential is not for this account.' }
        $State.credentialFile = $CredentialFile
      } elseif ($Mode -eq 'apply') { throw 'The credential was not stored.' }
    }
    'add-deny-ace' {
      if (-not (Test-DenyAce $Action.ace) -or $Action.ace.sid -ne $State.group.sid) { throw 'The recorded deny ACE is not on the deny root.' }
      $State.denyAces += , ([ordered]@{ path = $DenyRoot; sid = $Action.ace.sid; rights = 0x1f01ff; inheritance = 3; propagation = 0 })
    }
    'create-folder' {
      $allowed = @($SandboxRoot, (Join-Path $SandboxRoot 'runtime'), (Join-Path $SandboxRoot 'work'))
      if ($allowed -notcontains $Action.target -or -not (Test-FolderAcl $Action.target)) { throw "$($Action.target) does not have the planned protected ACL." }
      $State.folders += , $Action.target
    }
    default { throw "Cannot adopt $($Action.pendingKind)" }
  }
}

function Invoke-SetupAction($Action, $State, [string]$Nonce) {
  switch ($Action.kind) {
    'resolve-pending' { Resolve-Pending $Action $State }
    'create-group' {
      if ($Nonce -notmatch '^[0-9a-f]{6}$') { throw 'No nonce journaled.' }
      $g = New-LocalGroup -Name $Group -Description "$Marker #$Nonce"
      $State.group = [ordered]@{ name = $Group; sid = $g.SID.Value; nonce = $Nonce }
    }
    'create-user' {
      if ($Nonce -notmatch '^[0-9a-f]{6}$') { throw 'No nonce journaled.' }
      $secure = New-RandomPassword
      $u = New-LocalUser -Name $Account -Password $secure -Description "$Marker #$Nonce" -PasswordNeverExpires -UserMayNotChangePassword -AccountNeverExpires
      $State.account = [ordered]@{ name = $Account; sid = $u.SID.Value; nonce = $Nonce }
      Save-State $State
      New-Object System.Management.Automation.PSCredential("$Computer\$Account", $secure) | Export-Clixml -LiteralPath $CredentialFile
      if ((Import-Clixml -LiteralPath $CredentialFile).UserName -ne "$Computer\$Account") { throw 'The stored credential does not round-trip.' }
      $State.credentialFile = $CredentialFile
    }
    'add-member' {
      $user = Get-LocalUser -Name $Account
      if (-not $State.account -or $user.SID.Value -ne $State.account.sid) { throw "$Account is not the recorded account." }
      $groupSid = Resolve-GroupSid $Action.group $State
      # Idempotent: New-LocalUser may already have added the account to Users.
      if ((Get-MemberSids (Get-GroupNameBySid $groupSid)) -notcontains $user.SID.Value) { Add-LocalGroupMember -SID $groupSid -Member $user.SID }
    }
    'add-deny-ace' {
      if ($Action.target -ne $DenyRoot) { throw "Unexpected deny target $($Action.target)" }
      $sid = New-Object System.Security.Principal.SecurityIdentifier (Resolve-GroupSid $Action.group $State)
      $item = Get-Item -LiteralPath $DenyRoot -Force
      $acl = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
      $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Deny')))
      $item.SetAccessControl($acl)
      $State.denyAces += , ([ordered]@{ path = $DenyRoot; sid = $sid.Value; rights = 0x1f01ff; inheritance = 3; propagation = 0 })
    }
    'create-folder' {
      $allowed = @($SandboxRoot, (Join-Path $SandboxRoot 'runtime'), (Join-Path $SandboxRoot 'work'))
      if ($allowed -notcontains $Action.target) { throw "Unexpected folder $($Action.target)" }
      if (Test-Path -LiteralPath $Action.target) { throw "$($Action.target) appeared after planning." }
      # Created with its protected security descriptor in one call: there is never a moment when the
      # folder exists with inherited permissions.
      [void][System.IO.Directory]::CreateDirectory($Action.target, (New-FolderSecurity ([bool]$Action.grantGroupRead) $State))
      if (-not (Test-FolderAcl $Action.target)) { throw "$($Action.target) was not created with its protected ACL." }
      $State.folders += , $Action.target
    }
    default { throw "Unknown setup action $($Action.kind)" }
  }
}

function Invoke-RemovalAction($Action, $State) {
  switch ($Action.kind) {
    'resolve-pending' { Resolve-Pending $Action $State }
    'remove-deny-ace' {
      $ace = $Action.ace
      if ($ace.path -ne $DenyRoot) { throw "Unexpected deny target $($ace.path)" }
      if (-not @($State.denyAces | Where-Object { $_.path -eq $ace.path -and $_.sid -eq $ace.sid })) { throw 'The deny ACE is not recorded.' }
      $item = Get-Item -LiteralPath $DenyRoot -Force
      $acl = $item.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access)
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule((New-Object System.Security.Principal.SecurityIdentifier $ace.sid), [System.Security.AccessControl.FileSystemRights][int]$ace.rights, [System.Security.AccessControl.InheritanceFlags][int]$ace.inheritance, [System.Security.AccessControl.PropagationFlags][int]$ace.propagation, 'Deny')
      $acl.RemoveAccessRuleSpecific($rule)
      $item.SetAccessControl($acl)
      $State.denyAces = @($State.denyAces | Where-Object { -not ($_.path -eq $ace.path -and $_.sid -eq $ace.sid) })
    }
    'remove-folder' {
      if ($State.folders -notcontains $Action.target) { throw "Folder $($Action.target) is not recorded" }
      if ((Get-ReparseCount $Action.target) -gt 0) { throw "$($Action.target) contains links; not deleting." }
      Remove-Item -LiteralPath $Action.target -Recurse -Force
      $State.folders = @($State.folders | Where-Object { $_ -ne $Action.target })
    }
    'remove-profile' {
      if ($Action.sid -ne $State.account.sid -or $Action.sid -notmatch '^S-1-5-21-[0-9-]+$') { throw 'Profile SID does not match the recorded account.' }
      Get-CimInstance Win32_UserProfile -Filter "SID='$($Action.sid)'" | Remove-CimInstance
    }
    'remove-user' {
      if ($Action.sid -ne $State.account.sid) { throw 'User SID does not match the recorded account.' }
      Remove-LocalUser -SID $Action.sid
      $State.account = $null
    }
    'remove-group' {
      if ($Action.sid -ne $State.group.sid) { throw 'Group SID does not match the recorded group.' }
      Remove-LocalGroup -SID $Action.sid
      $State.group = $null
    }
    'remove-file' {
      if ($Action.target -eq $CredentialFile -and $Action.target -eq $State.credentialFile) {
        Remove-Item -LiteralPath $CredentialFile -Force
        $State.credentialFile = $null
      } elseif ($Action.target -eq $TokenFile) {
        Remove-Item -LiteralPath $TokenFile -Force
      } else { throw 'Unexpected file.' }
    }
    'forget-record' {
      # Clears the record of an object that no longer exists, after checking that it is really gone.
      switch ($Action.record) {
        'account' { if ($Action.sid -ne $State.account.sid -or (Get-LocalUser -SID $Action.sid -ErrorAction SilentlyContinue)) { throw 'The recorded account still exists.' }; $State.account = $null }
        'group' { if ($Action.sid -ne $State.group.sid -or (Get-LocalGroup -SID $Action.sid -ErrorAction SilentlyContinue)) { throw 'The recorded group still exists.' }; $State.group = $null }
        'deny-ace' {
          if (Test-DenyAce $Action.ace) { throw 'The recorded deny ACE is still there.' }
          $State.denyAces = @($State.denyAces | Where-Object { -not ($_.path -eq $Action.ace.path -and $_.sid -eq $Action.ace.sid) })
        }
        'folder' { if (Test-Path -LiteralPath $Action.target) { throw "$($Action.target) still exists." }; $State.folders = @($State.folders | Where-Object { $_ -ne $Action.target }) }
        'credential' { if (Test-Path -LiteralPath $CredentialFile) { throw 'The credential still exists.' }; $State.credentialFile = $null }
        default { throw "Unknown record $($Action.record)" }
      }
    }
    default { throw "Unknown removal action $($Action.kind)" }
  }
}

# ---------------------------------------------------------------------------
# Main

$inventory = Get-Inventory
if ($Mode -eq 'inventory') { $inventory | ConvertTo-Json -Depth 12; exit 0 }
$kind = if ($Mode -eq 'plan') { 'apply' } else { $Mode }
$result = Invoke-Planner $inventory $kind

if ($Mode -eq 'verify') {
  if ($Json) { $result | ConvertTo-Json -Depth 8 } else {
    foreach ($c in $result.checks) { Write-Output ("[{0}] {1}: {2}" -f $(if ($c.ok) { 'ok' } else { 'FAIL' }), $c.id, $c.detail) }
  }
  exit $(if ($result.ok) { 0 } else { 2 })
}

if ($Json) { $result | ConvertTo-Json -Depth 8 } else {
  Write-Output "Mode: $Mode ($($result.mode) plan)"
  foreach ($f in $result.findings) { Write-Output ("[{0}] {1}: {2}" -f $f.level, $f.topic, $f.message) }
  if ($result.actions.Count -eq 0) { Write-Output 'Planned changes: none.' } else {
    Write-Output 'Planned changes:'
    $i = 1
    foreach ($a in $result.actions) { Write-Output ("  {0}. {1}{2}" -f $i++, $a.description, $(if ($a.requiresElevation) { ' [elevated]' } else { '' })) }
  }
  Write-Output "Plan SHA-256: $($result.sha256)"
}
if ($result.blocked) { exit 2 }
if ($Mode -eq 'plan') { exit 0 }

if (-not $PlanSha256) { Stop-Setup "-$Mode needs -PlanSha256 <hash> from a reviewed plan." }
if ($PlanSha256 -ne $result.sha256) { Stop-Setup 'The plan changed since it was reviewed (hash differs). Nothing was changed.' }
if (-not $WhatIfPreference -and -not $inventory.elevated -and @($result.actions | Where-Object { $_.requiresElevation }).Count -gt 0) {
  Stop-Setup 'This plan creates or deletes accounts: run it from an elevated PowerShell. Nothing was changed.'
}

$state = if ($inventory.state) { $inventory.state } else { [pscustomobject][ordered]@{ schema = 2; computer = $Computer; account = $null; group = $null; denyAces = @(); folders = @(); credentialFile = $null; pending = $null } }
foreach ($action in $result.actions) {
  if ($PSCmdlet.ShouldProcess($action.target, $action.description)) {
    $nonce = if ($action.kind -in 'create-group', 'create-user') { New-Nonce } else { $null }
    # Intent first: the journal names the change before it starts, so an interruption is reconciled.
    if ($action.kind -notin 'resolve-pending', 'forget-record') {
      $state.pending = [ordered]@{ kind = $action.kind; target = $action.target; nonce = $nonce; startedAt = [DateTime]::UtcNow.ToString('o') }
      Save-State $state
    }
    if ($Mode -eq 'apply') { Invoke-SetupAction $action $state $nonce } else { Invoke-RemovalAction $action $state }
    $state.pending = $null
    Save-State $state
  }
}
if (-not $WhatIfPreference -and $Mode -eq 'remove' -and -not $state.account -and -not $state.group -and @($state.denyAces).Count -eq 0 -and @($state.folders).Count -eq 0 -and -not $state.credentialFile -and -not $state.pending) {
  Remove-Item -LiteralPath $StateFile -Force
}
exit 0

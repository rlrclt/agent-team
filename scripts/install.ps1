# Copy the role files into the user's Claude Code agents directory.
# usage: powershell -ExecutionPolicy Bypass -File scripts/install.ps1 [-Force]
#
# Claude Code discovers user-level subagents and --agent targets in
# ~/.claude/agents/. An existing file with the same name is left alone unless
# -Force is passed, so a local edit is not silently overwritten.
param([switch]$Force)

$Repo  = Split-Path -Parent $PSScriptRoot
$Src   = Join-Path $Repo 'agents'
$Dest  = Join-Path $HOME '.claude\agents'

if (-not (Test-Path $Src)) { throw "no agents/ directory in $Repo" }
New-Item -ItemType Directory -Force $Dest | Out-Null

$copied = 0; $skipped = 0
foreach ($f in Get-ChildItem $Src -Filter *.md) {
    $target = Join-Path $Dest $f.Name
    if ((Test-Path $target) -and -not $Force) {
        Write-Host "  skip   $($f.Name)  (exists - use -Force to overwrite)"
        $skipped++
        continue
    }
    Copy-Item $f.FullName $target -Force
    Write-Host "  copy   $($f.Name)"
    $copied++
}

Write-Host "`n$copied copied, $skipped skipped -> $Dest"
Write-Host @"

These files define the seats' roles. Edit them before seating a team - the
example roles are opinionated and yours will differ.

Note: a running Claude Code session does not notice a newly created agents
directory. If ~/.claude/agents did not exist before, restart your sessions.
"@

# Bring the whole agent-team up in one herdr workspace.
# usage: powershell -ExecutionPolicy Bypass -File scripts/seat-up.ps1 [-DryRun]
#
# Every seat runs the same way: claude --agent <role>. MCP servers, skills and
# plugins all come from the user's global config (~/.claude), so there is no
# per-seat settings file. What separates the seats is the role file: its system
# prompt and, where a role must not write, its tools list.
param([switch]$DryRun)

$Root  = Split-Path -Parent $PSScriptRoot
$Seats = @('orchestrator', 'builder', 'reviewer', 'qa', 'runner')

foreach ($s in $Seats) {
    $roleFile = Join-Path $HOME ".claude\agents\$s.md"
    if (-not (Test-Path $roleFile)) { throw "missing role file: $roleFile" }
}
Write-Host "preflight ok: $($Seats.Count) role files present"

if ($DryRun) {
    Write-Host "  would: herdr workspace create --cwd $Root --label agent-team --no-focus"
    $ws = 'wX'
} else {
    $ws = (herdr workspace create --cwd $Root --label agent-team --no-focus |
           ConvertFrom-Json).result.workspace.workspace_id
    if (-not $ws) { throw 'workspace create returned no id' }
}
Write-Host "workspace $ws"

for ($i = 0; $i -lt $Seats.Count; $i++) {
    $seat = $Seats[$i]
    $pane = "$ws" + ":p$($i + 1)"

    if ($i -gt 0) {
        if ($DryRun) { Write-Host "  would: herdr pane split --pane $ws`:p1 --direction right --ratio 0.5" }
        else { herdr pane split --pane "$ws`:p1" --direction right --ratio 0.5 | Out-Null }
    }

    $hargs = @('agent', 'start', $seat, '--kind', 'claude', '--pane', $pane,
               '--timeout', '120000', '--', '--agent', $seat)

    if ($DryRun) {
        Write-Host "  would: herdr $($hargs -join ' ')"
        continue
    }
    Write-Host "seating $seat in $pane"
    # agent start can exit non-zero on a SessionStart hook error even when the
    # agent did start, so the exit code is not the check - the listing below is.
    herdr @hargs 2>&1 | Out-Null
}

if ($DryRun) { Write-Host "`ndry run complete - nothing was started"; exit 0 }

Write-Host "`nverifying..."
$up = (herdr agent list | ConvertFrom-Json).result.agents |
      Where-Object { $_.workspace_id -eq $ws }
foreach ($s in $Seats) {
    $a = $up | Where-Object { $_.name -eq $s }
    if ($a) { Write-Host ("  {0,-13} {1,-8} {2}" -f $s, $a.pane_id, $a.agent_status) }
    else    { Write-Host ("  {0,-13} NOT STARTED" -f $s) }
}
if ($up.Count -lt $Seats.Count) {
    Write-Host "`n$($Seats.Count - $up.Count) seat(s) did not start. Re-run a single seat with:" -ForegroundColor Yellow
    Write-Host "  herdr agent start <seat> --kind claude --pane $ws`:pN -- --agent <seat>"
    exit 1
}
Write-Host "`nall $($Seats.Count) seats up"

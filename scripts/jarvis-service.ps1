<#
.SYNOPSIS
  Keeps Jarvis (the God's Eye View dev server) running in the background.
.DESCRIPTION
  install    Start Jarvis at login (hidden), re-check every 10 minutes, start now.
  uninstall  Stop Jarvis and remove the scheduled task.
  start      Enable the task and start Jarvis now.
  stop       Stop Jarvis and disable the task until "start".
  status     Show whether the task and the server are running.
.EXAMPLE
  pwsh ./scripts/jarvis-service.ps1 install
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'uninstall', 'start', 'stop', 'status')]
  [string]$Action = 'status'
)
$ErrorActionPreference = 'Stop'
$TaskName = 'GodsEyeView-Jarvis'
$Repo = Split-Path -Parent $PSScriptRoot
$StateDir = Join-Path $HOME '.gods-eye-view'
$PidFile = Join-Path $StateDir 'jarvis-service.pid'
$Launcher = Join-Path $StateDir 'jarvis-launch.vbs'
$Port = 4173

function Resolve-Node {
  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }
  $fallback = Join-Path $env:ProgramFiles 'nodejs\node.exe'
  if (Test-Path $fallback) { return $fallback }
  throw 'Node.js was not found. Install Node 24 or newer first.'
}

function Stop-Jarvis {
  if (-not (Test-Path $PidFile)) { return }
  $supervisor = [int](Get-Content $PidFile)
  # /T takes the dev server down together with its supervisor.
  & taskkill.exe /PID $supervisor /T /F *> $null
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
}

function Get-JarvisTask {
  Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

switch ($Action) {
  'install' {
    New-Item -ItemType Directory -Force $StateDir | Out-Null
    $node = Resolve-Node
    $script = Join-Path $Repo 'scripts\jarvis-service.mjs'
    # wscript starts node without a console window.
    $commandLine = "`"$node`" `"$script`""
    $vbsString = '"' + $commandLine.Replace('"', '""') + '"'
    Set-Content -Path $Launcher -Encoding ASCII -Value "CreateObject(`"WScript.Shell`").Run $vbsString, 0, False"

    $user = "$env:USERDOMAIN\$env:USERNAME"
    $taskAction = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Launcher`""
    $triggers = @(
      (New-ScheduledTaskTrigger -AtLogOn -User $user),
      (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 10))
    )
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $triggers -Settings $settings `
      -Principal $principal -Description "Keeps God's Eye View (Jarvis) running." -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    "Installed. Jarvis starts at login and is starting now (logs: $StateDir\logs)."
  }
  'uninstall' {
    Stop-Jarvis
    if (Get-JarvisTask) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false }
    Remove-Item $Launcher -Force -ErrorAction SilentlyContinue
    'Removed. Jarvis no longer starts on its own.'
  }
  'start' {
    if (-not (Get-JarvisTask)) { throw 'Not installed. Run: jarvis-service.ps1 install' }
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    'Starting.'
  }
  'stop' {
    if (Get-JarvisTask) { Disable-ScheduledTask -TaskName $TaskName | Out-Null }
    Stop-Jarvis
    'Stopped. It stays off until: jarvis-service.ps1 start'
  }
  'status' {
    $task = Get-JarvisTask
    $supervisorPid = if (Test-Path $PidFile) { [int](Get-Content $PidFile) } else { $null }
    $supervisor = if ($supervisorPid) { Get-Process -Id $supervisorPid -ErrorAction SilentlyContinue } else { $null }
    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    [pscustomobject]@{
      Task       = if ($task) { $task.State } else { 'not installed' }
      Supervisor = if ($supervisor) { "running (pid $supervisorPid)" } else { 'not running' }
      Server     = if ($listening) { "listening on port $Port" } else { 'not listening' }
    } | Format-List
  }
}

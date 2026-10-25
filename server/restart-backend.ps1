$D = Split-Path -Parent $MyInvocation.MyCommand.Path
$p = (Get-NetTCPConnection -LocalPort 8090 -State Listen -ErrorAction SilentlyContinue).OwningProcess; if ($p) { Stop-Process -Id $p -Force; Start-Sleep 1 }
Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine="cmd /c `"$D\run-backend.cmd`""} | Out-Null

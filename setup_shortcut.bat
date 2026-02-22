@echo off
setlocal
title Criar Atalhos - Oracle IoT ESP32

:: Escreve script PowerShell temporario para criar os atalhos
set TMP_PS=%TEMP%\create_iot_shortcuts.ps1
set PS_PATH=%~dp0start.ps1
set WORK_DIR=%~dp0

(
echo $ErrorActionPreference = 'Stop'
echo $shell      = New-Object -ComObject WScript.Shell
echo $desktop    = [Environment]::GetFolderPath^('Desktop'^)
echo $projectDir = '%WORK_DIR%'
echo $psFile     = '%PS_PATH%'
echo if ^(-not ^(Test-Path -LiteralPath $psFile^)^) { throw "Arquivo nao encontrado: $psFile" }
echo $quotedPs = '"' + $psFile + '"'
echo $shortcutPaths = @(
echo   ^(Join-Path $desktop 'IoT Backend.lnk'^),
echo   ^(Join-Path $projectDir 'IoT Backend.lnk'^)
echo ^)
echo foreach ^($lnkPath in $shortcutPaths^) ^{
echo   $lnk = $shell.CreateShortcut^($lnkPath^)
echo   $lnk.TargetPath       = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
echo   $lnk.Arguments        = "-ExecutionPolicy Bypass -NoProfile -File $quotedPs"
echo   $lnk.WorkingDirectory = $projectDir
echo   $lnk.IconLocation     = "$env:SystemRoot\System32\SHELL32.dll,14"
echo   $lnk.Description      = 'Iniciar Oracle IoT ESP32 Backend'
echo   $lnk.WindowStyle      = 1
echo   $lnk.Save^(^)
echo   Write-Host "Atalho criado/atualizado: $lnkPath" -ForegroundColor Green
echo ^}
echo Write-Host ''
echo Write-Host 'Duplo clique em [IoT Backend] para iniciar.' -ForegroundColor Cyan
echo Start-Sleep -Seconds 2
) > "%TMP_PS%"

powershell -ExecutionPolicy Bypass -NoProfile -File "%TMP_PS%"
del "%TMP_PS%" 2>nul

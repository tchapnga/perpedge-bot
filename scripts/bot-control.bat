@echo off
chcp 65001 >nul
powershell.exe -ExecutionPolicy Bypass -NoProfile -File "%~dp0bot-control.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERREUR] Le script a termine avec le code %ERRORLEVEL%
    pause
)

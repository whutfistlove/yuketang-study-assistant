@echo off
setlocal
chcp 65001 >nul
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 and add it to PATH.
  pause
  exit /b 1
)
node.exe "%~dp0main.cjs" --set-ai-key
set "APP_EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %APP_EXIT_CODE%

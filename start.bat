@echo off
rem Starts Quadri Music Studio and opens it in the browser (http://localhost:8096).
rem The studio loads YuE2 and the lyrics LLM itself when needed. Close this window (or Ctrl+C) to stop everything.
setlocal
cd /d "%~dp0"

if not exist runtime\installed (
  set QUADRI_NO_PAUSE=1
  call install.bat || goto :fail
)

set "NODE=%~dp0runtime\node\node.exe"
if not exist "%NODE%" set "NODE=node"

set STUDIO_OPEN=1
"%NODE%" backend\src\index.ts
if errorlevel 1 goto :fail
exit /b 0

:fail
echo.
echo The studio stopped with an error, see the messages above.
pause
exit /b 1

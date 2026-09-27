@echo off
rem Quadri Music Studio installer for Windows: Python + PyTorch, YuE2 models (~8 GB), lyrics LLM (~5 GB), web UI.
rem Everything goes into this folder. Safe to re-run: finished steps are skipped, downloads resume.
rem Options: install.bat --help
setlocal
cd /d "%~dp0"
set "NODE_VERSION=v24.18.0"

call :find_node && goto :run

echo Downloading Node.js %NODE_VERSION% (portable, into runtime\node)...
if not exist runtime mkdir runtime
curl.exe -fL --progress-bar -o runtime\node.zip "https://nodejs.org/dist/%NODE_VERSION%/node-%NODE_VERSION%-win-x64.zip" || goto :fail
if exist runtime\node.tmp rmdir /s /q runtime\node.tmp
if exist runtime\node rmdir /s /q runtime\node
mkdir runtime\node.tmp
"%SystemRoot%\System32\tar.exe" -xf runtime\node.zip -C runtime\node.tmp --strip-components=1 || goto :fail
move runtime\node.tmp runtime\node >nul || goto :fail
del runtime\node.zip
set "NODE=%~dp0runtime\node\node.exe"

:run
"%NODE%" scripts\install.ts %*
if errorlevel 1 goto :fail
if not defined QUADRI_NO_PAUSE pause
exit /b 0

:fail
echo.
echo Installation failed, see the messages above. Run install.bat again to continue where it stopped.
if not defined QUADRI_NO_PAUSE pause
exit /b 1

rem Node.js >= 23.6 runs the TypeScript sources directly: prefer runtime\node, else one on PATH
:find_node
set "NODE=%~dp0runtime\node\node.exe"
if exist "%NODE%" goto :check_node
set "NODE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE set "NODE=%%i"
if not defined NODE exit /b 1
:check_node
"%NODE%" -e "const [a, b] = process.versions.node.split('.').map(Number); process.exit(a > 23 || (a === 23 && b >= 6) ? 0 : 1)" 2>nul
exit /b %errorlevel%

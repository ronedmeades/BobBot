@echo off
setlocal enabledelayedexpansion

:: Bob Launcher - starts Bob if not running, opens dashboard in browser
:: Usage: double-click, or run from shortcut

:: Navigate to project root (one level up from scripts/)
cd /d "%~dp0.."

:: Read DASHBOARD_PORT from .env (default 3000)
set "PORT=3000"
if exist ".env" (
    for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
        set "KEY=%%a"
        :: Remove leading/trailing spaces
        for /f "tokens=* delims= " %%k in ("!KEY!") do set "KEY=%%k"
        if "!KEY!"=="DASHBOARD_PORT" (
            set "VAL=%%b"
            for /f "tokens=* delims= " %%v in ("!VAL!") do set "PORT=%%v"
        )
    )
)

set "URL=http://localhost:!PORT!"

:: Check if .env exists
if not exist ".env" (
    echo.
    echo  Bob is not configured yet.
    echo  Run: pnpm setup
    echo.
    pause
    exit /b 1
)

:: Check if Bob is already running (test the port)
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '!URL!/api/status' -TimeoutSec 2 -UseBasicParsing; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
    :: Bob is already running - just open the browser
    start "" "!URL!"
    exit /b 0
)

:: Bob is not running - start it minimized
echo  Starting Bob...
start "Bob" /min /d "%cd%" cmd /c pnpm dev

:: Wait for Bob to be ready (poll the port, max 30 seconds)
set /a "TRIES=0"
:wait_loop
if !TRIES! geq 30 (
    echo  Bob took too long to start. Check the console window for errors.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri '!URL!/api/status' -TimeoutSec 2 -UseBasicParsing; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 (
    :: Bob is ready - open the browser
    start "" "!URL!"
    exit /b 0
)
set /a "TRIES+=1"
goto wait_loop

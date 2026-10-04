@echo off
setlocal enabledelayedexpansion

@Rem ===========================================================================
@Rem  Launcher for the Pixel Streaming stack.
@Rem
@Rem  Starts, each in its own window:
@Rem    1. Wilbur  - the signalling server  (SignallingWebServer)
@Rem    2. SFU     - the multi-tenant mediasoup SFU  (SFU)
@Rem
@Rem  Usage:
@Rem    start_local.bat            Local test. The SFU advertises the local NIC IPs.
@Rem    start_local.bat --cloud    VPS. The SFU advertises the public IP.
@Rem    start_local.bat --https    Also serve https on 443 (run make_cert.bat first).
@Rem
@Rem  Close the Wilbur and SFU windows to stop them.
@Rem ===========================================================================

@Rem --- settings -------------------------------------------------------------
@Rem 1 = players can only see and subscribe to SFUs (raw streamers are hidden).
set "HIDE_NON_SFU=1"
set "STREAMER_PORT=8888"
set "PLAYER_PORT=80"
set "SFU_PORT=8889"
@Rem 1 = Wilbur proxies /snapshots to the SFU snapshot API so the grid previews
@Rem     load from the same origin as the page.
set "SNAPSHOT_PROXY=1"
set "SNAPSHOT_PORT=8891"
@Rem 1 = serve https as well as http (add --https on the command line).
set "HTTPS_PORT=443"
@Rem ---------------------------------------------------------------------------

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
set "WILBUR_DIR=%REPO_ROOT%\SignallingWebServer"
set "SFU_DIR=%REPO_ROOT%\SFU"

set "CLOUD=0"
set "HTTPS=0"
for %%a in (%*) do (
    if /I "%%a"=="--cloud" set "CLOUD=1"
    if /I "%%a"=="--https" set "HTTPS=1"
)

set "SCHEME=http"
if "%HTTPS%"=="1" set "SCHEME=https"
set "WEB_PORT=%PLAYER_PORT%"
if "%HTTPS%"=="1" set "WEB_PORT=%HTTPS_PORT%"

@Rem --- pre-flight -----------------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
    echo [ERROR] node was not found on PATH. Install Node.js and try again.
    pause
    exit /b 1
)

if not exist "%WILBUR_DIR%\dist\index.js" (
    echo [ERROR] Wilbur is not built. Run this first:
    echo     cd /d "%WILBUR_DIR%"
    echo     npm run build
    pause
    exit /b 1
)

if not exist "%REPO_ROOT%\Signalling\dist\cjs\pixelstreamingsignalling.js" (
    echo [ERROR] The Signalling library is not built. Run this first:
    echo     cd /d "%REPO_ROOT%\Signalling"
    echo     npm run build:cjs
    pause
    exit /b 1
)

if not exist "%SFU_DIR%\sfu_server.js" (
    echo [ERROR] "%SFU_DIR%\sfu_server.js" not found.
    pause
    exit /b 1
)

if "%HTTPS%"=="1" (
    if not exist "%WILBUR_DIR%\certificates\client-key.pem" (
        echo [ERROR] --https needs certificates and they are not there yet.
        echo         Run this once first:
        echo     make_cert.bat --trust
        pause
        exit /b 1
    )
    if not exist "%WILBUR_DIR%\certificates\client-cert.pem" (
        echo [ERROR] --https needs certificates and they are not there yet.
        echo         Run this once first:
        echo     make_cert.bat --trust
        pause
        exit /b 1
    )
)

@Rem --- build the Wilbur argument list ---------------------------------------
set "WILBUR_ARGS=--serve --streamer_port %STREAMER_PORT% --player_port %PLAYER_PORT% --sfu_port %SFU_PORT% --console_messages verbose --log_config"
if "%HIDE_NON_SFU%"=="1" set "WILBUR_ARGS=%WILBUR_ARGS% --hide_non_sfu_streamers"
if "%SNAPSHOT_PROXY%"=="1" set "WILBUR_ARGS=%WILBUR_ARGS% --snapshot_proxy --snapshot_proxy_host 127.0.0.1 --snapshot_proxy_port %SNAPSHOT_PORT%"
if "%HTTPS%"=="1" set "WILBUR_ARGS=%WILBUR_ARGS% --https --https_port %HTTPS_PORT% --ssl_key_path certificates/client-key.pem --ssl_cert_path certificates/client-cert.pem --https_redirect"

@Rem --- build the SFU argument list ------------------------------------------
set "SFU_ARGS="
if "%CLOUD%"=="1" (
    echo Resolving the public IP...
    for /f "usebackq tokens=*" %%i in (`curl -s https://api.ipify.org`) do set "PUBLICIP=%%i"
    if "!PUBLICIP!"=="" (
        echo [ERROR] Could not determine the public IP from https://api.ipify.org
        pause
        exit /b 1
    )
    set "SFU_ARGS=--PublicIP=!PUBLICIP!"
    echo Public IP: !PUBLICIP!
)

@Rem --- start Wilbur, unless something is already on the port ---------------
netstat -ano | findstr ":%SFU_PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 (
    echo [WARN] Port %SFU_PORT% is already in use - assuming Wilbur is already running.
    goto wilburup
)

echo Starting Wilbur (signalling server)...
start "Wilbur" /D "%WILBUR_DIR%" cmd /k node dist\index.js %WILBUR_ARGS%

echo Waiting for Wilbur to listen on port %SFU_PORT%...
set /a WAITED=0
:waitwilbur
@Rem ping is used instead of timeout because timeout refuses to run when stdin
@Rem is redirected, which would make this loop spin without ever sleeping.
ping -n 2 127.0.0.1 >nul
netstat -ano | findstr ":%SFU_PORT%" | findstr "LISTENING" >nul
if not errorlevel 1 goto wilburup
set /a WAITED+=1
if !WAITED! GEQ 30 (
    echo [ERROR] Wilbur did not start listening on port %SFU_PORT% within 30 seconds.
    echo         Check the Wilbur window for errors.
    pause
    exit /b 1
)
goto waitwilbur

:wilburup
echo Wilbur is up.

@Rem --- start the SFU --------------------------------------------------------
if "%CLOUD%"=="1" (
    echo Starting the SFU in cloud mode...
) else (
    echo Starting the SFU in local mode...
)
start "SFU" /D "%SFU_DIR%" cmd /k node sfu_server.js %SFU_ARGS%

@Rem --- done ----------------------------------------------------------------
echo.
echo Both processes are running in their own windows.
echo.
echo   Stream grid : %SCHEME%://localhost:%WEB_PORT%/
echo   Multiviewer : %SCHEME%://localhost:%WEB_PORT%/wall.html
echo   Player page : %SCHEME%://localhost:%WEB_PORT%/player.html?StreamerId=SFU-^<name^>
echo   Streamer    : ws://localhost:%STREAMER_PORT%
echo   SFU         : ws://localhost:%SFU_PORT%
if "%SNAPSHOT_PROXY%"=="1" echo   Snapshots   : %SCHEME%://localhost:%WEB_PORT%/snapshots
echo.
if "%HTTPS%"=="1" (
    echo HTTPS is on, so http://localhost:%PLAYER_PORT%/ now redirects to %SCHEME%://localhost:%WEB_PORT%/.
    echo The service worker, Wake Lock and Picture-in-Picture need this secure context.
    echo If the browser warns about the certificate, trust the local CA once with:
    echo     make_cert.bat --trust
) else (
    echo Tip: start_local.bat --https makes the frontend installable as an app.
)
echo.
echo Start your streamer (PlayerTracker + OBS) and it will be picked up automatically.
echo Close the Wilbur and SFU windows to stop them.
echo.

start "" "%SCHEME%://localhost:%WEB_PORT%/"
pause

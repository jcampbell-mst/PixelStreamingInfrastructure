@Rem Copyright Epic Games, Inc. All Rights Reserved.
@Rem
@Rem One-shot setup for a fresh clone of this repository on Windows.
@Rem
@Rem It downloads the Node runtime, installs the workspace dependencies, builds
@Rem the signalling server, the web frontend and the auth tools, prepares the
@Rem SFU, fetches the ffmpeg build that produces the stream previews, and
@Rem creates the first admin account so that the site can be signed into.
@Rem
@Rem   setup.bat                    asks for an admin username
@Rem   setup.bat --admin alice      creates that admin without asking
@Rem   setup.bat --no-admin         leaves accounts alone
@Rem   setup.bat --skip-build       dependencies only, no builds
@Rem
@Rem Run it again after every `git pull`. The start scripts skip rebuilding when
@Rem dist\ and www\ already exist, so without this step a pull would keep
@Rem serving the old compiled server and web pages.
@echo off
setlocal enabledelayedexpansion
title Pixel Streaming setup

set "REPO_DIR=%~dp0"
set "CMD_DIR=%REPO_DIR%SignallingWebServer\platform_scripts\cmd"
set "NODE_DIR=%CMD_DIR%\node"
set "NODE_EXE=%NODE_DIR%\node.exe"
set "NPM=%NODE_DIR%\npm.cmd"
set "CLI=%REPO_DIR%SignallingWebServer\dist\auth\cli.js"
set "ADMIN_USER="
set "SKIP_ADMIN=0"
set "SKIP_BUILD=0"
set "RC=0"

pushd "%REPO_DIR%"

if not exist "%REPO_DIR%package.json" goto :wrong_dir
if not exist "%REPO_DIR%SignallingWebServer\package.json" goto :wrong_dir

:parse_args
if "%~1"=="" goto :parsed
if /i "%~1"=="--admin" goto :arg_admin
if /i "%~1"=="--no-admin" goto :arg_no_admin
if /i "%~1"=="--skip-build" goto :arg_skip_build
if /i "%~1"=="--help" goto :usage
if /i "%~1"=="-h" goto :usage
echo Unknown option: %~1
goto :usage

:arg_admin
if "%~2"=="" (
    echo --admin needs a username, for example: setup.bat --admin alice
    goto :usage
)
set "ADMIN_USER=%~2"
shift
shift
goto :parse_args

:arg_no_admin
set "SKIP_ADMIN=1"
shift
goto :parse_args

:arg_skip_build
set "SKIP_BUILD=1"
shift
goto :parse_args

:usage
echo.
echo Usage: setup.bat [--admin ^<username^>] [--no-admin] [--skip-build]
echo.
echo   --admin ^<username^>  create an admin account with that username
echo   --no-admin          do not touch accounts at all
echo   --skip-build        install dependencies but do not build
echo.
echo Without --admin and --no-admin, setup.bat asks for a username.
goto :end

:wrong_dir
echo.
echo Run this script from the checkout it belongs to: package.json and
echo SignallingWebServer\package.json were not found next to it.
goto :fail

:parsed
echo.
echo ===========================================================
echo  Pixel Streaming setup
echo ===========================================================
echo  %REPO_DIR%
echo.
echo  There are seven steps. Steps 1, 5 and 6 download Node, ffmpeg and
echo  CoTURN, so this takes a few minutes on a fresh clone. Let it finish
echo  before starting the server.
echo.

call :EnsureNode
if errorlevel 1 goto :fail
call :InstallDeps
if errorlevel 1 goto :fail
call :Build
if errorlevel 1 goto :fail
call :SetupSfu
if errorlevel 1 goto :fail
call :FetchFfmpeg
if errorlevel 1 goto :fail
call :SetupCoturn
if errorlevel 1 goto :fail
call :CreateAdmin
if errorlevel 1 goto :fail
goto :summary

@Rem ---------------------------------------------------------------------------
@Rem 1. The Node runtime the start scripts use, downloaded into the checkout.
@Rem ---------------------------------------------------------------------------
:EnsureNode
echo [1/7] Node runtime
if exist "%NODE_EXE%" (
    echo       Already in place: %NODE_DIR%
    goto :node_done
)
where curl >nul 2>&1
if errorlevel 1 (
    echo       curl was not found. It ships with Windows 10 version 1803 and later.
    exit /b 1
)
where tar >nul 2>&1
if errorlevel 1 (
    echo       tar was not found. It ships with Windows 10 version 1803 and later.
    exit /b 1
)
set "NODE_VERSION="
for /f "usebackq delims=" %%v in ("%REPO_DIR%NODE_VERSION") do set "NODE_VERSION=%%v"
if "!NODE_VERSION!"=="" (
    echo       %REPO_DIR%NODE_VERSION is empty, so the version to download is unknown.
    exit /b 1
)
set "NODE_NAME=node-!NODE_VERSION!-win-x64"
echo       Downloading !NODE_NAME! from nodejs.org, about 30 MB ...
pushd "%CMD_DIR%"
curl -L -o node.zip "https://nodejs.org/dist/!NODE_VERSION!/!NODE_NAME!.zip"
if not "!errorlevel!"=="0" (
    popd
    echo       The download failed. Check that this machine can reach nodejs.org.
    exit /b 1
)
tar -xf node.zip
if not "!errorlevel!"=="0" (
    popd
    echo       Unpacking node.zip failed.
    exit /b 1
)
ren "!NODE_NAME!" node
del node.zip
popd
:node_done
set "PATH=%NODE_DIR%;%PATH%"
for /f "usebackq delims=" %%v in (`"%NODE_EXE%" --version`) do echo       Node %%v ready
exit /b 0

@Rem ---------------------------------------------------------------------------
@Rem 2. Dependencies for every workspace: libraries, server, frontend.
@Rem ---------------------------------------------------------------------------
:InstallDeps
echo [2/7] Dependencies
if not exist "%NPM%" (
    echo       %NPM% is missing, so the Node runtime was not set up correctly.
    exit /b 1
)
echo       npm install, which covers the server, the frontend and the libraries ...
pushd "%REPO_DIR%"
call "%NPM%" install --no-fund --no-audit
set "DEP_RC=!errorlevel!"
popd
if not "!DEP_RC!"=="0" (
    echo       npm install failed. The output above says why.
    exit /b 1
)
exit /b 0

@Rem ---------------------------------------------------------------------------
@Rem 3. Build the compiled server, the web pages and the account tools.
@Rem ---------------------------------------------------------------------------
:Build
echo [3/7] Build
if "%SKIP_BUILD%"=="1" (
    echo       Skipped because of --skip-build.
    exit /b 0
)
echo       npm run build:all:cjs ...
pushd "%REPO_DIR%"
call "%NPM%" run build:all:cjs
set "BUILD_RC=!errorlevel!"
popd
if not "!BUILD_RC!"=="0" (
    echo       The build failed. The output above names the project that failed.
    exit /b 1
)
if not exist "%CLI%" (
    echo       The build finished but %CLI% is missing.
    exit /b 1
)
if not exist "%REPO_DIR%SignallingWebServer\dist\index.js" (
    echo       The build finished but SignallingWebServer\dist\index.js is missing.
    exit /b 1
)
if not exist "%REPO_DIR%SignallingWebServer\www\grid.html" (
    echo       The build finished but SignallingWebServer\www\grid.html is missing.
    exit /b 1
)
exit /b 0

@Rem ---------------------------------------------------------------------------
@Rem 4. The SFU, which hosts the streams and produces the previews. It keeps its
@Rem    own Node runtime and its own dependency install.
@Rem ---------------------------------------------------------------------------
:SetupSfu
echo [4/7] SFU
if not exist "%REPO_DIR%SFU\platform_scripts\cmd\setup.bat" (
    echo       SFU\platform_scripts\cmd\setup.bat is missing from this checkout.
    exit /b 1
)
@Rem The launcher scripts below call their sibling batch files by bare name, which
@Rem cmd refuses to resolve when NoDefaultCurrentDirectoryInExePath is set.
set "NoDefaultCurrentDirectoryInExePath="
pushd "%REPO_DIR%SFU\platform_scripts\cmd"
call "%REPO_DIR%SFU\platform_scripts\cmd\setup.bat"
set "SFU_RC=!errorlevel!"
popd
if not "!SFU_RC!"=="0" (
    echo       The SFU setup failed. Without it no stream can be hosted.
    exit /b 1
)
exit /b 0

@Rem ---------------------------------------------------------------------------
@Rem 5. ffmpeg, which the SFU runs to turn each stream into a preview frame.
@Rem    Optional: the grid shows placeholders without it.
@Rem ---------------------------------------------------------------------------
:FetchFfmpeg
echo [5/7] ffmpeg for the stream previews
if exist "%REPO_DIR%Extras\ffmpeg\win64-x64\ffmpeg.exe" (
    echo       Already in place.
    exit /b 0
)
where powershell >nul 2>&1
if errorlevel 1 (
    echo       PowerShell was not found, so ffmpeg cannot be fetched. The grid
    echo       will show placeholders until ffmpeg is present or on PATH.
    exit /b 0
)
echo       Downloading the static ffmpeg build from BtbN/FFmpeg-Builds, about 100 MB ...
powershell -NoProfile -ExecutionPolicy Bypass -File "%REPO_DIR%Extras\ffmpeg\fetch-ffmpeg.ps1"
if not "!errorlevel!"=="0" (
    echo       The ffmpeg download failed, so the grid will show placeholders.
    echo       Run setup.bat again when this machine can reach github.com.
    exit /b 0
)
exit /b 0

@Rem ---------------------------------------------------------------------------
@Rem 6. CoTURN, which the launcher runs so that viewers behind a restrictive NAT
@Rem    can still reach the streams. Optional: start_with_turn.bat fetches it
@Rem    itself on the first run.
@Rem ---------------------------------------------------------------------------
:SetupCoturn
echo [6/7] CoTURN
if exist "%REPO_DIR%SignallingWebServer\platform_scripts\cmd\coturn\turnserver.exe" (
    echo       Already in place.
    exit /b 0
)
pushd "%REPO_DIR%SignallingWebServer\platform_scripts\cmd"
echo       Downloading CoTURN, about 3 MB ...
curl -L -o turnserver.zip "https://github.com/EpicGamesExt/PixelStreamingInfrastructure/releases/download/v4.5.2-coturn-windows/turnserver.zip"
if not "!errorlevel!"=="0" (
    popd
    echo       The CoTURN download failed. start_with_turn.bat will try again when
    echo       it starts, so the streams themselves are unaffected.
    exit /b 0
)
if not exist coturn mkdir coturn
tar -xf turnserver.zip -C coturn
set "COTURN_RC=!errorlevel!"
del turnserver.zip
popd
if not "!COTURN_RC!"=="0" (
    echo       Unpacking CoTURN failed. start_with_turn.bat will try again when it
    echo       starts, so the streams themselves are unaffected.
    exit /b 0
)
exit /b 0

@Rem ---------------------------------------------------------------------------
@Rem 7. The first admin account. Nothing is reachable until one exists.
@Rem ---------------------------------------------------------------------------
:CreateAdmin
echo [7/7] Accounts
if "%SKIP_ADMIN%"=="1" (
    echo       Skipped because of --no-admin.
    exit /b 0
)
if not "!ADMIN_USER!"=="" goto :admin_create
echo       The site is closed until an admin account exists. Its password is
echo       generated and printed once, so copy it before closing this window.
set /p "ADMIN_USER=      Admin username, or blank to skip: "
if "!ADMIN_USER!"=="" (
    echo       Skipped. Create an account later, from SignallingWebServer:
    echo           "%NODE_EXE%" dist\auth\cli.js create-admin USERNAME
    exit /b 0
)
:admin_create
echo       Creating "!ADMIN_USER!" ...
pushd "%REPO_DIR%SignallingWebServer"
"%NODE_EXE%" "%CLI%" create-admin "!ADMIN_USER!"
set "ADMIN_RC=!errorlevel!"
popd
if not "!ADMIN_RC!"=="0" (
    echo       No account was created. If that name already has a password, set a
    echo       new one for it instead, from SignallingWebServer:
    echo           "%NODE_EXE%" dist\auth\cli.js set-password !ADMIN_USER!
    exit /b 0
)
exit /b 0

:summary
echo.
echo ===========================================================
echo  Setup finished.
echo ===========================================================
echo.
echo  Start the server with the launcher in
echo  SignallingWebServer\platform_scripts\cmd:
echo.
echo      start_with_turn.bat --player_port 8080 --reverse_proxy
echo.
echo  --reverse_proxy tells the server that Caddy is in front of it, so it
echo  trusts the forwarded visitor address and marks the session cookie
echo  Secure. Keep it in your start script.
echo.
echo  Start the SFU alongside it with SFU\platform_scripts\cmd\run_cloud.bat,
echo  or use run_local.bat on a machine without a public address. The SFU hosts
echo  the streams and serves the previews, so the grid depends on it.
echo.
echo  CoTURN, fetched in step 6, is what the launcher runs next to the server
echo  so that visitors behind a strict NAT can still connect. It needs no
echo  configuration; start_with_turn.bat starts it for you.
echo.
echo  Sign in at https://your-domain/login and hand out invites from
echo  https://your-domain/admin. No page links to /admin on purpose.
echo.
echo  Accounts, invites and sessions live in SignallingWebServer\data\auth.json
echo  That file is not in git, and it is the only way into the site, so keep a
echo  copy of it and never commit or share it.
echo.
echo  The streamer port, 8888 by default, is NOT behind the sign-in. Anyone who
echo  can reach it can publish a stream, so limit it to where you stream from:
echo      netsh advfirewall firewall add rule name="PixelStreaming streamer" dir=in action=allow protocol=TCP localport=8888 remoteip=1.2.3.4
echo.
echo  Re-run setup.bat after every "git pull" and restart the server, otherwise
echo  the old build keeps running.
echo.
set "RC=0"
goto :end

:fail
echo.
echo Setup did not finish. Fix the problem above and run setup.bat again.
set "RC=1"

:end
popd
echo.
pause
endlocal & exit /b %RC%

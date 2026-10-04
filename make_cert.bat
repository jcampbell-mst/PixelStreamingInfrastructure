@echo off
setlocal enabledelayedexpansion

@Rem ===========================================================================
@Rem  Creates the TLS certificates Wilbur needs for https mode.
@Rem
@Rem  A local certificate authority is created once, and a server certificate is
@Rem  signed by it for this machine: localhost, the loopback addresses, the host
@Rem  name and every local IPv4 address, so the same cert works from this machine
@Rem  and from anything on the LAN.
@Rem
@Rem  Why bother: service workers, the Wake Lock API and Picture-in-Picture only
@Rem  exist in a secure context. localhost is treated as secure, a plain HTTP LAN
@Rem  address is not, so the installable app needs real https.
@Rem
@Rem  Usage:
@Rem    make_cert.bat            Create the certificates (skips if already there).
@Rem    make_cert.bat --force    Recreate them, e.g. after the IP changed.
@Rem    make_cert.bat --trust    Also trust the CA on this machine (needs admin).
@Rem
@Rem  Output (paths are what SignallingWebServer\config.json expects):
@Rem    SignallingWebServer\certificates\client-key.pem
@Rem    SignallingWebServer\certificates\client-cert.pem
@Rem    SignallingWebServer\certificates\ps-local-ca-cert.pem   <- trust this
@Rem
@Rem  Then run:  start_local.bat --https
@Rem ===========================================================================

set "REPO_ROOT=%~dp0"
if "%REPO_ROOT:~-1%"=="\" set "REPO_ROOT=%REPO_ROOT:~0,-1%"
set "CERT_DIR=%REPO_ROOT%\SignallingWebServer\certificates"
set "KEY=%CERT_DIR%\client-key.pem"
set "CRT=%CERT_DIR%\client-cert.pem"
set "CA_KEY=%CERT_DIR%\ps-local-ca-key.pem"
set "CA_CRT=%CERT_DIR%\ps-local-ca-cert.pem"
set "EXT=%CERT_DIR%\server.ext"
set "CSR=%CERT_DIR%\server.csr"

set "FORCE=0"
set "TRUST=0"
for %%a in (%*) do (
    if /I "%%a"=="--force" set "FORCE=1"
    if /I "%%a"=="--trust" set "TRUST=1"
)

@Rem --- find openssl ---------------------------------------------------------
set "OPENSSL="
if exist "%ProgramFiles%\Git\mingw64\bin\openssl.exe" set "OPENSSL=%ProgramFiles%\Git\mingw64\bin\openssl.exe"
if not defined OPENSSL if exist "%ProgramFiles(x86)%\Git\mingw64\bin\openssl.exe" set "OPENSSL=%ProgramFiles(x86)%\Git\mingw64\bin\openssl.exe"
if not defined OPENSSL if exist "%LOCALAPPDATA%\Programs\Git\mingw64\bin\openssl.exe" set "OPENSSL=%LOCALAPPDATA%\Programs\Git\mingw64\bin\openssl.exe"
if not defined OPENSSL for /f "delims=" %%i in ('where openssl 2^>nul') do if not defined OPENSSL set "OPENSSL=%%i"

if not defined OPENSSL (
    echo [ERROR] openssl was not found. Install Git for Windows ^(it ships openssl^)
    echo         or put openssl.exe on PATH, then run this again.
    pause
    exit /b 1
)
echo Using openssl: %OPENSSL%

if not exist "%CERT_DIR%" mkdir "%CERT_DIR%" >nul 2>nul

if "%FORCE%"=="0" if exist "%KEY%" if exist "%CRT%" (
    echo Certificates already exist. Use --force to recreate them.
    echo   %CRT%
    goto trust
)

@Rem --- build the subject alternative name list ------------------------------
@Rem No pipeline in the PowerShell call: a `|` inside a `for /f` backquoted
@Rem command has to be careted, and the caret survives into PowerShell. The
@Rem foreach/if form stays pipe-free and therefore argument-safe.
set "LANIPS="
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "$ips = foreach ($a in (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue)) { if ($a.IPAddress -notlike '127.*' -and $a.PrefixOrigin -ne 'WellKnown') { $a.IPAddress } }; $ips -join ','"`) do set "LANIPS=%%i"

set "SAN=DNS:localhost,DNS:%COMPUTERNAME%,IP:127.0.0.1,IP:::1"
if defined LANIPS (
    for %%i in (%LANIPS%) do set "SAN=!SAN!,IP:%%i"
)
echo Subject alternative names: %SAN%

@Rem --- 1. the certificate authority -----------------------------------------
if "%FORCE%"=="1" if exist "%CA_KEY%" del /q "%CA_KEY%"
if not exist "%CA_KEY%" (
    echo Creating the local certificate authority...
    "%OPENSSL%" req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes ^
        -keyout "%CA_KEY%" -out "%CA_CRT%" ^
        -subj "/CN=Pixel Streaming Local Dev CA/O=ExperimentalPS" ^
        -addext "basicConstraints=critical,CA:TRUE" ^
        -addext "keyUsage=critical,keyCertSign,cRLSign" || goto failed
)

@Rem --- 2. the server key and signing request --------------------------------
echo Creating the server key...
"%OPENSSL%" req -newkey rsa:2048 -sha256 -nodes ^
    -keyout "%KEY%" -out "%CSR%" ^
    -subj "/CN=%COMPUTERNAME%/O=ExperimentalPS" || goto failed

@Rem --- 3. sign it, with the SANs the browsers actually check ---------------
> "%EXT%" echo basicConstraints=CA:FALSE
>> "%EXT%" echo keyUsage=critical,digitalSignature,keyEncipherment
>> "%EXT%" echo extendedKeyUsage=serverAuth
>> "%EXT%" echo subjectAltName=%SAN%

echo Signing the server certificate...
@Rem 825 days is the longest a leaf certificate may live before Chrome and Safari
@Rem refuse it, regardless of who signed it.
"%OPENSSL%" x509 -req -in "%CSR%" -CA "%CA_CRT%" -CAkey "%CA_KEY%" -CAcreateserial ^
    -out "%CRT%" -days 825 -sha256 -extfile "%EXT%" || goto failed

del /q "%CSR%" >nul 2>nul
del /q "%CERT_DIR%\ps-local-ca-cert.srl" >nul 2>nul

echo.
echo Certificates written to %CERT_DIR%
"%OPENSSL%" x509 -in "%CRT%" -noout -subject -dates -ext subjectAltName

:trust
if "%TRUST%"=="0" goto advice

echo.
echo Importing the CA into the machine trust store ^(needs admin^)...
certutil -addstore -f Root "%CA_CRT%"
if errorlevel 1 (
    echo [WARN] Could not import the CA. Run this script from an elevated prompt,
    echo        or import "%CA_CRT%" manually into Trusted Root Certification Authorities.
) else (
    echo CA trusted. Restart the browser so it picks up the new root.
)

:advice
echo.
echo Next steps:
echo   1. start_local.bat --https
echo   2. Open https://localhost/ ^(no redirect, so no certificate prompt^)
echo.
echo Browsers only run service workers, Wake Lock and PiP for a trusted origin.
echo If you see a certificate warning, trust "%CA_CRT%" with:
echo     make_cert.bat --trust        ^(elevated^)
echo On another device, install ps-local-ca-cert.pem as a trusted root first.
echo.
pause
exit /b 0

:failed
echo.
echo [ERROR] Certificate creation failed. Nothing was changed; check the openssl output above.
pause
exit /b 1

@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul
echo ============================================================
echo  Murmur - One-Click Windows Build
echo  (first run auto-installs missing tools; may take a while)
echo ============================================================
cd /d "%~dp0"

rem ---------- Node.js ----------
where node >nul 2>nul
if errorlevel 1 (
  echo [SETUP] Node.js not found.
  where winget >nul 2>nul
  if errorlevel 1 ( echo [FAIL] winget not available. Install Node.js 22 LTS from https://nodejs.org then re-run. & pause & exit /b 1 )
  echo [SETUP] Installing Node.js LTS via winget...
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements || ( echo [FAIL] Node install failed. & pause & exit /b 1 )
  set "PATH=%ProgramFiles%\nodejs;%PATH%"
)

rem ---------- Rust ----------
where cargo >nul 2>nul
if errorlevel 1 (
  echo [SETUP] Rust/Cargo not found.
  where winget >nul 2>nul
  if errorlevel 1 ( echo [FAIL] winget not available. Install Rust from https://rustup.rs then re-run. & pause & exit /b 1 )
  echo [SETUP] Installing Rust via winget...
  winget install --id Rustlang.Rustup -e --accept-source-agreements --accept-package-agreements || ( echo [FAIL] Rust install failed. & pause & exit /b 1 )
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
  rustup default stable >nul 2>nul
)

rem ---------- MSVC build tools (needed by SQLCipher native build) ----------
where link >nul 2>nul
if not errorlevel 1 goto :msvc_done
echo [SETUP] MSVC linker not found. Installing Visual Studio 2022 Build Tools - this is a large one-time download...
where winget >nul 2>nul
if errorlevel 1 ( echo [FAIL] Install "Visual Studio 2022 Build Tools" with the C++ workload, then re-run. & pause & exit /b 1 )
set "BT_TRIES=0"
:bt_retry
set /a BT_TRIES+=1
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --accept-source-agreements --accept-package-agreements --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
if not errorlevel 1 goto :bt_ok
if !BT_TRIES! GEQ 3 ( echo [FAIL] Build Tools install failed after 3 attempts. & pause & exit /b 1 )
echo [SETUP] Build Tools install hit a transient error (often MSI error 1618 - another installation is in progress). Waiting 30 seconds and retrying (attempt !BT_TRIES! of 3)...
timeout /t 30 /nobreak >nul
goto :bt_retry
:bt_ok
echo [SETUP] Build Tools installed. If the build below still cannot find the linker, restart this script once.
:msvc_done

rem ---------- Perl (needed to compile the bundled SQLCipher OpenSSL) ----------
where perl >nul 2>nul
if errorlevel 1 (
  echo [SETUP] Perl not found. Installing Strawberry Perl via winget...
  where winget >nul 2>nul
  if errorlevel 1 ( echo [FAIL] winget not available. Install Strawberry Perl from https://strawberryperl.com then re-run. & pause & exit /b 1 )
  winget install --id StrawberryPerl.StrawberryPerl -e --accept-source-agreements --accept-package-agreements || ( echo [FAIL] Perl install failed. & pause & exit /b 1 )
  set "PATH=C:\Strawberry\perl\bin;%PATH%"
)

rem ---------- Version consistency ----------
rem (standalone scripts only - inline node -e in a .bat gets mangled by cmd parsing)
node scripts\check-version.cjs
if errorlevel 1 ( pause & exit /b 1 )
for /f %%v in ('node scripts\print-version.cjs') do set "VER=%%v"

echo [1/4] Installing JavaScript dependencies...
call npm install || goto :fail
echo [2/4] Checking Rust backend...
call npm run check || goto :fail
echo [3/4] Building Windows installer (NSIS)...
call npm run build -- --bundles nsis || goto :fail

echo [4/5] Collecting release files into .\release\ ...
if not exist release mkdir release
for %%f in ("src-tauri\target\release\bundle\nsis\*.exe") do (
  copy /y "%%f" "release\Murmur-%VER%-Windows-Setup.exe" >nul
)
if not exist "release\Murmur-%VER%-Windows-Setup.exe" ( echo [FAIL] Installer not found in bundle output. & goto :fail )
cd release
certutil -hashfile "Murmur-%VER%-Windows-Setup.exe" SHA256 | findstr /v "hash CertUtil" > "Murmur-%VER%-Windows-Setup.exe.sha256.txt"
cd ..

echo [5/5] Building portable (no-install) package...
set "PDIR=release\Murmur-%VER%-Windows-Portable"
if exist "%PDIR%" rmdir /s /q "%PDIR%"
mkdir "%PDIR%"
if not exist "src-tauri\target\release\murmur.exe" ( echo [FAIL] Portable binary not found. & goto :fail )
copy /y "src-tauri\target\release\murmur.exe" "%PDIR%\Murmur.exe" >nul
type nul > "%PDIR%\portable.mode"
copy /y "便携版说明.md" "%PDIR%\便携版说明.md" >nul
powershell -NoProfile -Command "Compress-Archive -Path '%PDIR%\*' -DestinationPath 'release\Murmur-%VER%-Windows-Portable.zip' -Force" || ( echo [FAIL] Portable zip failed. & goto :fail )
certutil -hashfile "release\Murmur-%VER%-Windows-Portable.zip" SHA256 | findstr /v "hash CertUtil" > "release\Murmur-%VER%-Windows-Portable.zip.sha256.txt"
echo.
echo ============================================================
echo  BUILD SUCCESSFUL
echo  Installer: release\Murmur-%VER%-Windows-Setup.exe
echo  Portable : release\Murmur-%VER%-Windows-Portable.zip (unzip anywhere, no install)
echo  Send that single .exe to the counselor. Data is NOT inside
echo  the installer; it stays in the app data folder on their PC.
echo ============================================================
start "" explorer "%CD%\release"
pause
exit /b 0
:fail
echo.
echo BUILD FAILED. Scroll up to the first [FAIL] or error line.
pause
exit /b 1

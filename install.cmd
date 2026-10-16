@echo off
rem ============================================================================
rem  DSH desktop-pet plugin - one-click installer launcher
rem
rem  WHY THIS FILE EXISTS
rem
rem  Windows blocks .ps1 files by default: the execution policy is "Restricted",
rem  so double-clicking / right-clicking install-pet.ps1 fails with
rem
rem      cannot be loaded because running scripts is disabled on this system
rem
rem  A .cmd file is NOT subject to the execution policy. So this launcher simply
rem  re-invokes the PowerShell script with -ExecutionPolicy Bypass, which means
rem  the user needs to prepare NOTHING: no policy change, no admin rights,
rem  no manual command. Double-click this file.
rem
rem  IMPORTANT - this file is intentionally pure ASCII.
rem
rem  cmd.exe reads .cmd files using the SYSTEM ANSI code page, ignoring any BOM
rem  and ignoring `chcp` written inside the file. On a Chinese Windows that is
rem  GBK, so UTF-8 Chinese text turns to mojibake and shreds the batch syntax.
rem  An earlier Chinese-commented .cmd of mine broke exactly that way. Keeping
rem  this file ASCII makes it safe on every Windows locale.
rem
rem  All Chinese output comes from install-pet.ps1, which is UTF-8 with BOM and
rem  is read by PowerShell (not by cmd.exe), so it renders correctly.
rem ============================================================================

setlocal
set "HERE=%~dp0"
set "PS1=%HERE%install-pet.ps1"

echo.
echo   DSH desktop-pet plugin - one-click install
echo   ==========================================
echo.

rem ---- locate the PowerShell script -------------------------------------------
if not exist "%PS1%" (
    echo   [X] install-pet.ps1 not found next to this launcher.
    echo.
    echo       Expected: %PS1%
    echo.
    echo       Please keep all extracted files in the SAME folder.
    goto :hold
)

rem ---- make sure powershell.exe exists (it always does on Windows 7+) ---------
where powershell.exe >nul 2>nul
if errorlevel 1 (
    echo   [X] powershell.exe not found on this system.
    echo       This launcher needs Windows PowerShell ^(built into Windows 7 and later^).
    goto :hold
)

rem ---- run it with the execution policy bypassed for this process only --------
rem  -NoProfile  : ignore the user's profile, so a broken profile cannot break us
rem  -Bypass     : this process only; nothing on the machine is changed
rem  %*          : forward any extra arguments, e.g. -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
set "RC=%ERRORLEVEL%"

echo.
rem  /I makes the comparison case-insensitive, so this still takes the success
rem  branch if ERRORLEVEL ever comes back without a plain decimal form.
if /I "%RC%"=="0" (
    echo   Finished. Press any key to close this window.
) else (
    echo   [X] The installer reported an error ^(exit code %RC%^).
    echo       Scroll up for details, or run this for a preview only:
    echo         install-pet.ps1 -WhatIf
)

:hold
rem  Keep the window open so a double-clicking user can actually read the output.
echo.
pause >nul
endlocal
exit /b 0

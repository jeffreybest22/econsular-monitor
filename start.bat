@echo off
title E-Consular Monitor - Ambassade Bresil
echo Demarrage du moniteur e-consular...
echo Appuyez sur Ctrl+C pour arreter.
echo.
cd /d "%~dp0"
node monitor.js
pause

@echo off
cd /d "%~dp0"
title Auralis Local Preview
echo Starting Auralis locally...
start "Auralis Preview Server" cmd /k "npm run preview"
timeout /t 2 /nobreak >nul
start "" msedge --app="http://127.0.0.1:4173"
exit

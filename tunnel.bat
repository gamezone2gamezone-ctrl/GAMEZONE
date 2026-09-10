@echo off
cd /d %~dp0
title GAME ZONE - Cloudflare Tunnel
echo 1) Make sure the site server is running (start.bat)
echo 2) Copy the ADMIN URL that appears after a few seconds:
echo    https://........trycloudflare.com/admin.html
echo.
"%LOCALAPPDATA%\GameZone\cloudflared.exe" tunnel --url http://localhost:3000 --no-autoupdate --protocol http2 --logfile "%LOCALAPPDATA%\GameZone\tunnel.log"
pause
#Requires -RunAsAdministrator
$ErrorActionPreference = "Stop"

Write-Host "[INFO] Installing Node.js LTS and FFmpeg with Chocolatey..."
choco upgrade nodejs-lts ffmpeg -y
Write-Host "[INFO] Installation finished. Reopen the terminal before running verification."

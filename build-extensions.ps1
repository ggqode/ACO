# build-extensions.ps1
# Automates building the extension packages for both Chromium and Firefox.

# 1. Package Chromium extension (Chrome / Edge / Brave / Opera)
Write-Host "Packaging for Chromium (Chrome/Edge/Brave)..." -ForegroundColor Green
if (Test-Path "ACO-chromium.zip") { Remove-Item "ACO-chromium.zip" }
# manifest.json is already configured for Chromium
Compress-Archive -Path "extension/*" -DestinationPath "ACO-chromium.zip" -Force

# 2. Package Firefox extension
Write-Host "Packaging for Firefox..." -ForegroundColor Green
if (Test-Path "ACO-firefox.zip") { Remove-Item "ACO-firefox.zip" }
# Backup Chromium manifest
Copy-Item -Path "extension/manifest.json" -Destination "extension/manifest.json.bak" -Force
try {
    # Copy Firefox manifest
    Copy-Item -Path "extension/manifest.firefox.json" -Destination "extension/manifest.json" -Force
    # Package Firefox files
    Compress-Archive -Path "extension/*" -DestinationPath "ACO-firefox.zip" -Force
} finally {
    # Restore Chromium manifest
    Copy-Item -Path "extension/manifest.json.bak" -Destination "extension/manifest.json" -Force
    Remove-Item -Path "extension/manifest.json.bak" -Force
}

Write-Host "Done! Generated ACO-chromium.zip and ACO-firefox.zip successfully." -ForegroundColor Cyan

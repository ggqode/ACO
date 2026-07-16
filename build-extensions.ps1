# build-extensions.ps1
# Automates building the extension packages for both Chromium and Firefox.

Add-Type -AssemblyName System.IO.Compression.FileSystem

# 1. Package Chromium extension (Chrome / Edge / Brave / Opera)
Write-Host "Packaging for Chromium (Chrome/Edge/Brave)..." -ForegroundColor Green
if (Test-Path "ACO-chromium.zip") { Remove-Item "ACO-chromium.zip" -Force }
# manifest.json is already configured for Chromium
python build_zip.py extension ACO-chromium.zip

# 2. Package Firefox extension
Write-Host "Packaging for Firefox..." -ForegroundColor Green
# Backup Chromium manifest
Copy-Item -Path "extension/manifest.json" -Destination "extension/manifest.json.bak" -Force
try {
    # Copy Firefox manifest
    Copy-Item -Path "extension/manifest.firefox.json" -Destination "extension/manifest.json" -Force
    
    # Try to remove old archive, handling file locks gracefully
    if (Test-Path "ACO-firefox.zip") {
        try {
            Remove-Item "ACO-firefox.zip" -Force -ErrorAction Stop
        } catch {
            Write-Warning "Plik ACO-firefox.zip jest zablokowany przez inny proces. Spowoduje to blad pakowania."
        }
    }
    
    # Package Firefox files
    python build_zip.py extension ACO-firefox.zip
} catch {
    Write-Error "Blad podczas budowania Firefox zip: $_"
} finally {
    # Restore Chromium manifest
    Copy-Item -Path "extension/manifest.json.bak" -Destination "extension/manifest.json" -Force
    Remove-Item -Path "extension/manifest.json.bak" -Force
}

Write-Host "Done! Generated ACO-chromium.zip and ACO-firefox.zip successfully." -ForegroundColor Cyan

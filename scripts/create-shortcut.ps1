# Bob - Desktop Shortcut & Auto-Start Installer
# Run with: pnpm shortcut
# Or directly: powershell -ExecutionPolicy Bypass -File scripts/create-shortcut.ps1

param(
    [switch]$Uninstall
)

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$launcherVbs = Join-Path $projectRoot "scripts\launcher.vbs"
$iconPath = Join-Path $projectRoot "assets\bob-icon.ico"
$shortcutName = "Bob.lnk"
$desktopPath = [Environment]::GetFolderPath("Desktop")
$startupPath = [Environment]::GetFolderPath("Startup")
$desktopShortcut = Join-Path $desktopPath $shortcutName
$startupShortcut = Join-Path $startupPath $shortcutName

function Create-Shortcut($path) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = "wscript.exe"
    $shortcut.Arguments = "`"$launcherVbs`""
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.Description = "Launch Bob - AI Personal Agent"
    if (Test-Path $iconPath) {
        $shortcut.IconLocation = "$iconPath,0"
    }
    $shortcut.Save()
}

# --- Uninstall mode ---
if ($Uninstall) {
    Write-Host ""
    Write-Host "  Removing Bob shortcuts..." -ForegroundColor Yellow

    if (Test-Path $desktopShortcut) {
        Remove-Item $desktopShortcut -Force
        Write-Host "  Removed desktop shortcut" -ForegroundColor Green
    } else {
        Write-Host "  No desktop shortcut found" -ForegroundColor Gray
    }

    if (Test-Path $startupShortcut) {
        Remove-Item $startupShortcut -Force
        Write-Host "  Removed auto-start shortcut" -ForegroundColor Green
    } else {
        Write-Host "  No auto-start shortcut found" -ForegroundColor Gray
    }

    Write-Host ""
    Write-Host "  Done!" -ForegroundColor Green
    Write-Host ""
    exit 0
}

# --- Install mode ---
Write-Host ""
Write-Host "  =================================" -ForegroundColor Cyan
Write-Host "   Bob - Shortcut Setup" -ForegroundColor Cyan
Write-Host "  =================================" -ForegroundColor Cyan
Write-Host ""

# Check prerequisites
if (-not (Test-Path $launcherVbs)) {
    Write-Host "  Error: launcher.vbs not found at $launcherVbs" -ForegroundColor Red
    Write-Host "  Make sure you are running this from the Bob project root." -ForegroundColor Red
    exit 1
}

# Desktop shortcut
$createDesktop = Read-Host "  Create desktop shortcut? (Y/n)"
if ($createDesktop -eq "" -or $createDesktop -match "^[Yy]") {
    Create-Shortcut $desktopShortcut
    Write-Host "  Desktop shortcut created!" -ForegroundColor Green
    Write-Host "  You can also pin this to your taskbar by right-clicking it." -ForegroundColor Gray
    Write-Host ""
} else {
    Write-Host "  Skipped desktop shortcut." -ForegroundColor Gray
    Write-Host ""
}

# Auto-start on login
Write-Host "  Auto-start: Bob starts silently when Windows starts,"
Write-Host "  so your browser bookmark always works instantly."
Write-Host ""
$autoStart = Read-Host "  Start Bob automatically on login? (y/N)"
if ($autoStart -match "^[Yy]") {
    Create-Shortcut $startupShortcut
    Write-Host "  Auto-start enabled!" -ForegroundColor Green
    Write-Host "  Bob will start in the background when you log in." -ForegroundColor Gray
    Write-Host "  To disable later: pnpm shortcut:remove" -ForegroundColor Gray
    Write-Host ""
} else {
    # Remove auto-start if it was previously set
    if (Test-Path $startupShortcut) {
        Remove-Item $startupShortcut -Force
        Write-Host "  Auto-start disabled (removed previous shortcut)." -ForegroundColor Yellow
    } else {
        Write-Host "  Skipped auto-start." -ForegroundColor Gray
    }
    Write-Host ""
}

Write-Host "  =================================" -ForegroundColor Cyan
Write-Host "   Setup complete!" -ForegroundColor Cyan
Write-Host "  =================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  To launch Bob: double-click the desktop shortcut"
Write-Host "  Or just open http://localhost:3000 in your browser"
Write-Host ""

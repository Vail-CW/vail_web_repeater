# PowerShell script to update version number across all HTML files
# Usage: .\update-version.ps1 1.0.1

param(
    [Parameter(Mandatory=$true)]
    [string]$NewVersion
)

Write-Host "Updating version to $NewVersion..." -ForegroundColor Green

# Get the directory where this script is located
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Update version.js
$versionJsPath = Join-Path $ScriptDir "version.js"
if (Test-Path $versionJsPath) {
    $content = Get-Content $versionJsPath -Raw
    $content = $content -replace 'const APP_VERSION = "[\d\.]+";', "const APP_VERSION = `"$NewVersion`";"
    Set-Content -Path $versionJsPath -Value $content -NoNewline
    Write-Host "Updated version.js" -ForegroundColor Cyan
} else {
    Write-Host "Warning: version.js not found" -ForegroundColor Yellow
}

# Update all HTML files
$htmlFiles = @("index.html", "events.html")

foreach ($htmlFile in $htmlFiles) {
    $htmlPath = Join-Path $ScriptDir $htmlFile
    if (Test-Path $htmlPath) {
        $content = Get-Content $htmlPath -Raw
        # Replace all version parameters in script and link tags
        $content = $content -replace '\?v=[\d\.]+', "?v=$NewVersion"
        Set-Content -Path $htmlPath -Value $content -NoNewline
        Write-Host "Updated $htmlFile" -ForegroundColor Cyan
    } else {
        Write-Host "Warning: $htmlFile not found" -ForegroundColor Yellow
    }
}

Write-Host ""
Write-Host "Version update complete!" -ForegroundColor Green
Write-Host "All files now use version: $NewVersion" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "1. Test the changes locally" -ForegroundColor White
Write-Host "2. Commit the changes: git add . && git commit -m 'Bump version to $NewVersion'" -ForegroundColor White
Write-Host "3. Deploy to production" -ForegroundColor White

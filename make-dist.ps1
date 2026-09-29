# Build a distributable Keyway for Windows.
#
#   powershell -ExecutionPolicy Bypass -File make-dist.ps1 [-Arch x64|arm64] [-NodeVersion v22.11.0]
#
# Produces dist\Keyway\ (Keyway.exe + resources\) and dist\Keyway-Windows-<arch>.zip.
# Needs nothing beyond Windows itself: Keyway.exe is compiled with the C#
# compiler that ships with .NET Framework 4.8, and Node is downloaded from nodejs.org.
#
# Optional code signing: set SIGNTOOL_CERT (path to .pfx) and SIGNTOOL_PASSWORD.
param(
  [ValidateSet('x64', 'arm64')] [string]$Arch = 'x64',
  [string]$NodeVersion = $(if ($env:NODE_VERSION) { $env:NODE_VERSION } else { 'v22.11.0' })
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Dir   = $PSScriptRoot
$Dist  = Join-Path $Dir 'dist'
$Cache = Join-Path $Dir '.cache'
$App   = Join-Path $Dist 'Keyway'
$Res   = Join-Path $App 'resources'
$Zip   = Join-Path $Dist "Keyway-Windows-$Arch.zip"

if (Test-Path $Dist) { Remove-Item -Recurse -Force $Dist }
New-Item -ItemType Directory -Force $Res, $Cache | Out-Null

# --- icon (PNG-in-ICO, drawn so the repo carries no binary assets) ---
Add-Type -AssemblyName System.Drawing
$ico = Join-Path $Cache 'keyway.ico'
$bmp = New-Object System.Drawing.Bitmap 256, 256
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([System.Drawing.Color]::Transparent)
$g.FillEllipse((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(217, 119, 6))), 8, 8, 240, 240)
$font = New-Object System.Drawing.Font 'Segoe UI', 136, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$sf = New-Object System.Drawing.StringFormat; $sf.Alignment = 'Center'; $sf.LineAlignment = 'Center'
$g.DrawString('K', $font, [System.Drawing.Brushes]::White, (New-Object System.Drawing.RectangleF 0, 8, 256, 256), $sf)
$g.Dispose()
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
$png = $ms.ToArray()
$w = New-Object System.IO.BinaryWriter ([System.IO.File]::Create($ico))
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)             # ICONDIR
$w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0); $w.Write([byte]0) # 256x256, no palette
$w.Write([uint16]1); $w.Write([uint16]32); $w.Write([uint32]$png.Length); $w.Write([uint32]22)
$w.Write($png); $w.Close()

# --- Keyway.exe ---
Write-Host 'compiling Keyway.exe...'
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
& $csc -nologo -codepage:65001 -target:winexe -optimize+ -warnaserror+ `
  "-win32icon:$ico" "-out:$(Join-Path $App 'Keyway.exe')" `
  -r:System.Windows.Forms.dll -r:System.Drawing.dll -r:System.Web.Extensions.dll -r:System.Core.dll `
  (Join-Path $Dir 'app\windows\Keyway.cs') | Where-Object { $_ -and $_ -notmatch 'This compiler|C# 5|go.microsoft' }
if ($LASTEXITCODE -ne 0) { throw 'csc failed' }

# --- Node runtime ---
Write-Host "bundling Node $NodeVersion ($Arch)..."
$nodeExe = Join-Path $Cache "node-$NodeVersion-$Arch.exe"
if (-not (Test-Path $nodeExe)) {
  $url = "https://nodejs.org/dist/$NodeVersion/win-$Arch/node.exe"
  Invoke-WebRequest -UseBasicParsing $url -OutFile "$nodeExe.part"
  # Verify against the published checksums.
  $sums = (Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt").Content
  $want = ($sums -split "`n" | Where-Object { $_ -match "\s+win-$Arch/node\.exe$" } | ForEach-Object { ($_ -split '\s+')[0] })
  $got = (Get-FileHash -Algorithm SHA256 "$nodeExe.part").Hash.ToLower()
  if (-not $want -or $want.ToLower() -ne $got) { Remove-Item "$nodeExe.part"; throw "node.exe checksum mismatch ($got)" }
  Move-Item "$nodeExe.part" $nodeExe
}
Copy-Item $nodeExe (Join-Path $Res 'node.exe')
Copy-Item (Join-Path $Dir 'setup.mjs'), (Join-Path $Dir 'gateway.mjs') $Res

@"
Keyway for Windows
==================

Double-click Keyway.exe, pick your provider, paste your API key, and click Install.
Claude Desktop restarts and uses your models. A "K" icon appears in the tray.

If Windows SmartScreen warns about an unrecognised app: More info -> Run anyway.

Installed to:  %LOCALAPPDATA%\Keyway      (gateway, config.json, key, gateway.log)
Claude profile: %LOCALAPPDATA%\Claude-3p
Starts at login via: HKCU\Software\Microsoft\Windows\CurrentVersion\Run  (value "Keyway")

To remove: open Keyway again and click Remove.
https://github.com/shivamtiwari3/keyway
"@ | Set-Content -Encoding UTF8 (Join-Path $App 'README.txt')

# --- optional signing ---
if ($env:SIGNTOOL_CERT) {
  Write-Host 'signing...'
  $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\signtool.exe" -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1
  if (-not $signtool) { throw 'SIGNTOOL_CERT set but signtool.exe not found (install the Windows SDK)' }
  & $signtool.FullName sign /f $env:SIGNTOOL_CERT /p $env:SIGNTOOL_PASSWORD /fd SHA256 /tr http://timestamp.digicert.com /td SHA256 (Join-Path $App 'Keyway.exe')
  if ($LASTEXITCODE -ne 0) { throw 'signing failed' }
} else {
  Write-Host 'note: unsigned build (set SIGNTOOL_CERT/SIGNTOOL_PASSWORD to sign)'
}

Compress-Archive -Path $App -DestinationPath $Zip -Force
Write-Host "built: $App"
Write-Host "zip:   $Zip ($([math]::Round((Get-Item $Zip).Length / 1MB, 1)) MB)"

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
Set-Location $root

$node = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& node -p "process.versions.node").Trim()
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt 20) {
  throw "Node.js 20+ is required, found $nodeVersion"
}

$build = Join-Path $root "build"
$dist = Join-Path $root "dist"
New-Item -ItemType Directory -Force -Path $build, $dist | Out-Null

Write-Host "==> Bundling server (CJS)"
& npx --yes esbuild@0.25.0 server.mjs --bundle --platform=node --format=cjs --charset=utf8 --log-level=warning --outfile="$build/server.cjs"
if ($LASTEXITCODE -ne 0) { throw "esbuild server failed" }

Write-Host "==> Bundling SEA entry"
& npx --yes esbuild@0.25.0 packaging/sea-entry.cjs --bundle --platform=node --format=cjs --charset=utf8 --log-level=warning --outfile="$build/sea-app.cjs"
if ($LASTEXITCODE -ne 0) { throw "esbuild entry failed" }

$assets = [ordered]@{
  "index.html" = "index.html"
  "styles.css" = "styles.css"
  "app.js" = "app.js"
  "markdown.js" = "markdown.js"
  "markdown-worker.js" = "markdown-worker.js"
  "deepseek-icon.png" = "deepseek-icon.png"
}
$seaConfig = [ordered]@{
  main = "build/sea-app.cjs"
  output = "build/sea-prep.blob"
  disableExperimentalSEAWarning = $true
  useSnapshot = $false
  useCodeCache = $true
  assets = $assets
}
$configPath = Join-Path $build "sea-config.json"
[System.IO.File]::WriteAllText($configPath, ($seaConfig | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))

Write-Host "==> Generating SEA blob"
& node --experimental-sea-config $configPath
if ($LASTEXITCODE -ne 0) { throw "SEA blob generation failed" }

$exe = Join-Path $dist "DeepSeek-Web.exe"
Write-Host "==> Copying Node runtime"
Copy-Item -LiteralPath $node -Destination $exe -Force

Write-Host "==> Injecting SEA blob"
& npx --yes postject@1.0.0-alpha.6 $exe NODE_SEA_BLOB "$build/sea-prep.blob" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
if ($LASTEXITCODE -ne 0) { throw "postject failed" }

$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $exe).Length
$hashFile = Join-Path $dist "DeepSeek-Web.exe.sha256"
[System.IO.File]::WriteAllText($hashFile, "$hash  DeepSeek-Web.exe`r`n", (New-Object System.Text.UTF8Encoding($false)))

Write-Host ""
Write-Host "Built: $exe"
Write-Host ("Size:  {0:N1} MB" -f ($size / 1MB))
Write-Host "SHA256: $hash"
Write-Host "Note: unsigned EXE; Windows SmartScreen may show a warning."

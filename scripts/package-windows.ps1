param([string]$MakensisPath)

$ErrorActionPreference = 'Stop'
$project = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json
$electron = Join-Path $project 'node_modules/electron/dist'
$release = Join-Path $project 'tmp/windows-release'
$stage = Join-Path $release ('stage-' + [Guid]::NewGuid().ToString('N'))
$profile = Join-Path $env:APPDATA 'OE DESK/workbench'

if (!$MakensisPath) {
  $compiler = Get-Command makensis.exe -ErrorAction SilentlyContinue
  if ($compiler) { $MakensisPath = $compiler.Source }
  else {
    $cache = Join-Path $env:LOCALAPPDATA 'electron-builder/Cache/nsis'
    $MakensisPath = Get-ChildItem -LiteralPath $cache -Filter makensis.exe -File -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty FullName
  }
}
if (!$MakensisPath -or !(Test-Path -LiteralPath $MakensisPath -PathType Leaf)) {
  throw 'Install NSIS or pass -MakensisPath with the full compiler path.'
}
if (!(Test-Path -LiteralPath (Join-Path $electron 'electron.exe') -PathType Leaf)) {
  throw 'Run npm ci to install the bundled Electron runtime.'
}

$installer = Join-Path $release ("OE-DESK-Setup-{0}.exe" -f $package.version)
$stagedInstaller = Join-Path $stage ([System.IO.Path]::GetFileName($installer))
$app = Join-Path $stage 'program/resources/app'
$program = Join-Path $stage 'program'
New-Item -Path $program -ItemType Directory -Force | Out-Null
try {
  foreach ($entry in Get-ChildItem -LiteralPath $electron) {
    Copy-Item -LiteralPath $entry.FullName -Destination $program -Recurse
  }
  Rename-Item -LiteralPath (Join-Path $program 'electron.exe') -NewName 'OE DESK.exe'
  $defaultApp = Join-Path $program 'resources/default_app.asar'
  if (Test-Path -LiteralPath $defaultApp -PathType Leaf) { Remove-Item -LiteralPath $defaultApp }
  New-Item -Path $app -ItemType Directory | Out-Null
  foreach ($entry in @('index.html', 'server.js', 'client', 'electron', 'rpa', 'server')) {
    Copy-Item -LiteralPath (Join-Path $project $entry) -Destination $app -Recurse
  }
  $answerBasis = 'web-chat/backend/answer-basis.mjs'
  $bundledAnswerBasis = Join-Path $app $answerBasis
  New-Item -Path (Split-Path -Parent $bundledAnswerBasis) -ItemType Directory -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $project $answerBasis) -Destination $bundledAnswerBasis
  [ordered]@{
    name = $package.name
    productName = $package.productName
    version = $package.version
    type = $package.type
    main = 'electron/main.cjs'
    private = $true
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $app 'package.json') -Encoding utf8

  Push-Location -LiteralPath $project
  try {
    $dependencies = @(npm ls --omit=dev --all --parseable)
    if ($LASTEXITCODE -ne 0) { throw 'Could not list production dependencies.' }
  } finally { Pop-Location }
  $dependencyRoot = Join-Path $project 'node_modules'
  $stagedDependencies = Join-Path $app 'node_modules'
  foreach ($dependency in $dependencies) {
    if ($dependency -eq $project) { continue }
    $relative = [System.IO.Path]::GetRelativePath($dependencyRoot, $dependency)
    if ($relative -eq '..' -or $relative.StartsWith('..' + [System.IO.Path]::DirectorySeparatorChar) -or
        [System.IO.Path]::IsPathRooted($relative)) { throw 'Production dependency is outside node_modules.' }
    $destination = Join-Path $stagedDependencies $relative
    if (Test-Path -LiteralPath $destination) { continue }
    New-Item -Path (Split-Path -Parent $destination) -ItemType Directory -Force | Out-Null
    Copy-Item -LiteralPath $dependency -Destination $destination -Recurse
  }

  & $MakensisPath /V2 "/DAPP_STAGE=$program" "/DINSTALLER_FILE=$stagedInstaller" "/DAPP_VERSION=$($package.version)" (Join-Path $PSScriptRoot 'windows-installer.nsi')
  if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $stagedInstaller -PathType Leaf)) { throw 'NSIS did not build the installer.' }

  New-Item -Path (Join-Path $profile 'data') -ItemType Directory -Force | Out-Null
  foreach ($entry in @('.env', 'knowledge-base', 'data/training-qa.json', 'data/self-learning.json',
      'data/prompt-settings.json', 'data/workflow-config.json', 'data/workbench-operations.json')) {
    $existing = Join-Path $project $entry
    $destination = Join-Path $profile $entry
    if ((Test-Path -LiteralPath $existing) -and !(Test-Path -LiteralPath $destination)) {
      Copy-Item -LiteralPath $existing -Destination $destination -Recurse
    }
  }
  $currentFeige = Join-Path $project 'data/feige-messages.json'
  $installedFeige = Join-Path $profile 'data/feige-messages.json'
  if ((Test-Path -LiteralPath $currentFeige) -and !(Test-Path -LiteralPath $installedFeige)) {
    $settings = Get-Content -LiteralPath $currentFeige -Raw | ConvertFrom-Json
    @{ replyMode = $settings.replyMode; listening = $settings.listening } |
      ConvertTo-Json | Set-Content -LiteralPath $installedFeige -Encoding utf8
  }

  Move-Item -LiteralPath $stagedInstaller -Destination $installer -Force
  Write-Output "Installer: $installer"
  Write-Output "Local workbench data: $profile"
} finally {
  $resolvedStage = (Resolve-Path -LiteralPath $stage -ErrorAction SilentlyContinue).Path
  $resolvedRelease = (Resolve-Path -LiteralPath $release -ErrorAction SilentlyContinue).Path
  if ($resolvedStage -and (Split-Path -Parent $resolvedStage) -eq $resolvedRelease -and
      (Split-Path -Leaf $resolvedStage) -match '^stage-[a-f0-9]{32}$') {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}

$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$projectVersion = (Get-Content -LiteralPath (Join-Path $project 'package.json') -Raw | ConvertFrom-Json).version
$release = Join-Path $project 'tmp/windows-release'
$publicInstaller = Join-Path $release "OE-DESK-Setup-$projectVersion.exe"
$profile = Join-Path $env:APPDATA 'OE DESK/workbench'
$transfer = Join-Path $env:LOCALAPPDATA 'OE DESK/private-transfer'
$stage = Join-Path $transfer ('build-' + [Guid]::NewGuid().ToString('N'))
$archiveCache = Join-Path $env:LOCALAPPDATA 'electron-builder/Cache/7zip@1.0.0'
$nsisCache = Join-Path $env:LOCALAPPDATA 'electron-builder/Cache/nsis'
$archiver = Get-ChildItem -LiteralPath $archiveCache -Filter 7za.exe -File -Recurse | Select-Object -First 1 -ExpandProperty FullName
$compiler = Get-ChildItem -LiteralPath $nsisCache -Filter makensis.exe -File -Recurse | Select-Object -First 1 -ExpandProperty FullName
if (!$compiler -or !$archiver -or !(Test-Path -LiteralPath $publicInstaller -PathType Leaf)) {
  throw 'The public installer, NSIS, and the 7-Zip command-line bundle are required.'
}
$archiverPackage = Split-Path -Parent (Split-Path -Parent $archiver)
$installerName = "OE-DESK-Private-Setup-$projectVersion.exe"
$installer = Join-Path $release $installerName
$passwordFile = Join-Path $transfer "OE-DESK-Private-Setup-$projectVersion-password.txt"
$modelSettings = @(Get-Content -LiteralPath (Join-Path $profile '.env') |
  Where-Object { $_ -match '^\s*(RAG_PROVIDER|OPENAI_BASE_URL|OPENAI_API_KEY|OPENAI_CHAT_MODEL|OPENAI_EMBED_MODEL|OLLAMA_BASE_URL|OLLAMA_CHAT_MODEL|OLLAMA_EMBED_MODEL|RAG_EMBEDDING_ENABLED)\s*=' })
if (!($modelSettings -match '^\s*OPENAI_API_KEY\s*=\s*[^\s"]')) {
  throw 'The current packaged profile has no OpenAI-compatible API key.'
}
if (!(Test-Path -LiteralPath (Join-Path $profile 'knowledge-base') -PathType Container)) {
  throw 'The current packaged profile has no knowledge base.'
}

$password = if (Test-Path -LiteralPath $passwordFile -PathType Leaf) {
  (Get-Content -LiteralPath $passwordFile -Raw).Trim()
} else {
  $seed = New-Object byte[] 12
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($seed) } finally { $random.Dispose() }
  ([BitConverter]::ToString($seed)).Replace('-', '').ToLowerInvariant()
}
if ($password -cnotmatch '^[0-9a-f]{24}$') { throw 'The existing private installer password file is invalid.' }

$payload = Join-Path $stage 'workbench'
$data = Join-Path $payload 'data'
$encryptedProfile = Join-Path $stage 'Profile.7z'
$stagedInstaller = Join-Path $stage $installerName
New-Item -Path $data -ItemType Directory -Force | Out-Null
try {
  $modelSettings | Set-Content -LiteralPath (Join-Path $payload '.env') -Encoding utf8
  Copy-Item -LiteralPath (Join-Path $profile 'knowledge-base') -Destination $payload -Recurse
  foreach ($name in @('training-qa.json', 'self-learning.json', 'prompt-settings.json', 'workflow-config.json', 'workbench-operations.json')) {
    $source = Join-Path $profile ('data/' + $name)
    if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-Item -LiteralPath $source -Destination $data }
  }
  @{
    listening = $false
    replyMode = 'off'
  } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $data 'feige-messages.json') -Encoding utf8

  Push-Location -LiteralPath $stage
  try {
    & $archiver a -t7z -mhe=on -mx=3 "-p$password" $encryptedProfile workbench | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the encrypted profile.' }
    & $archiver t "-p$password" $encryptedProfile | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not verify the encrypted profile.' }
  } finally { Pop-Location }
  $archiveLicense = Join-Path $archiverPackage 'LICENSE.txt'
  $archiveCopying = Join-Path $archiverPackage 'COPYING'
  & $compiler /V2 /INPUTCHARSET UTF8 "/DINSTALLER_FILE=$stagedInstaller" "/DPUBLIC_INSTALLER=$publicInstaller" "/DENCRYPTED_PROFILE=$encryptedProfile" "/DARCHIVER=$archiver" "/DARCHIVER_LICENSE=$archiveLicense" "/DARCHIVER_COPYING=$archiveCopying" (Join-Path $PSScriptRoot 'private-windows-installer.nsi')
  if ($LASTEXITCODE -ne 0 -or !(Test-Path -LiteralPath $stagedInstaller -PathType Leaf)) { throw 'NSIS did not build the private installer.' }

  Set-Content -LiteralPath $passwordFile -Value $password -Encoding ascii
  Move-Item -LiteralPath $stagedInstaller -Destination $installer -Force
  Write-Output "Private installer: $installer"
  Write-Output "Password file: $passwordFile"
} finally {
  $resolvedStage = (Resolve-Path -LiteralPath $stage -ErrorAction SilentlyContinue).Path
  $resolvedTransfer = (Resolve-Path -LiteralPath $transfer -ErrorAction SilentlyContinue).Path
  if ($resolvedStage -and (Split-Path -Parent $resolvedStage) -eq $resolvedTransfer -and
      (Split-Path -Leaf $resolvedStage) -match '^build-[a-f0-9]{32}$') {
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}

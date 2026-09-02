param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$BlenderArgs
)

$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..')).Path
$blenderRoot = Join-Path $projectRoot '.tools\blender\blender-5.2.1-windows-x64'
$blenderExe = Join-Path $blenderRoot 'blender.exe'
$portableRoot = Join-Path $blenderRoot 'portable'

if (-not (Test-Path -LiteralPath $blenderExe)) {
  throw "Portable Blender was not found at $blenderExe"
}

$resourceDirectories = @(
  $portableRoot,
  (Join-Path $portableRoot 'config'),
  (Join-Path $portableRoot 'datafiles'),
  (Join-Path $portableRoot 'scripts'),
  (Join-Path $portableRoot 'extensions'),
  (Join-Path $portableRoot 'temp'),
  (Join-Path $portableRoot 'appdata'),
  (Join-Path $portableRoot 'localappdata')
)
New-Item -ItemType Directory -Force -Path $resourceDirectories | Out-Null

$environmentOverrides = @{
  BLENDER_USER_RESOURCES = $portableRoot
  BLENDER_USER_CONFIG = Join-Path $portableRoot 'config'
  BLENDER_USER_DATAFILES = Join-Path $portableRoot 'datafiles'
  BLENDER_USER_SCRIPTS = Join-Path $portableRoot 'scripts'
  BLENDER_USER_EXTENSIONS = Join-Path $portableRoot 'extensions'
  APPDATA = Join-Path $portableRoot 'appdata'
  LOCALAPPDATA = Join-Path $portableRoot 'localappdata'
  TEMP = Join-Path $portableRoot 'temp'
  TMP = Join-Path $portableRoot 'temp'
}
$previousEnvironment = @{}
foreach ($name in $environmentOverrides.Keys) {
  $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  [Environment]::SetEnvironmentVariable($name, $environmentOverrides[$name], 'Process')
}

$blenderExitCode = 1
try {
  & $blenderExe @BlenderArgs
  $blenderExitCode = $LASTEXITCODE
}
finally {
  foreach ($name in $previousEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
  }
}
exit $blenderExitCode

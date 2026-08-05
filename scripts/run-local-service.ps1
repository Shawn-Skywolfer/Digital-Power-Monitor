param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("api", "web")]
  [string]$Service,

  [Parameter(Mandatory = $true)]
  [string]$NodeExecutable
)

$workspace = Split-Path -Parent $PSScriptRoot
$logDirectory = Join-Path $workspace "data\logs"
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
Set-Location -LiteralPath $workspace

if ($Service -eq "api") {
  & $NodeExecutable "node_modules\tsx\dist\cli.mjs" "server\index.ts" *> (Join-Path $logDirectory "api.log")
} else {
  & $NodeExecutable "node_modules\vinext\dist\cli.js" "dev" *> (Join-Path $logDirectory "web.log")
}

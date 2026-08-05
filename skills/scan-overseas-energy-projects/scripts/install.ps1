$ErrorActionPreference = "Stop"
$skillRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$targetRoot = Join-Path $env:USERPROFILE ".codex\skills\scan-overseas-energy-projects"
New-Item -ItemType Directory -Force -Path $targetRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $skillRoot "SKILL.md") -Destination $targetRoot -Force
Copy-Item -LiteralPath (Join-Path $skillRoot "agents") -Destination $targetRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $skillRoot "references") -Destination $targetRoot -Recurse -Force
Copy-Item -LiteralPath (Join-Path $skillRoot "scripts") -Destination $targetRoot -Recurse -Force
Write-Host "已安装 Skill：$targetRoot"

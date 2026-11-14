#requires -Version 5.1
<#
  Prepara o deploy por Git para Qualidade (uma unica vez):
  - cria o repositorio bare /opt/zeroops/repo.git no servidor QA e instala o hook post-receive;
  - configura logrotate para /var/log/zeroops/deploy.log;
  - adiciona o remote `qa` ao repositorio local.
  Depois disso: git push qa main  (publica, faz backup da BD, migra e valida a saude).
  Nunca usar contra Producao.
#>
param(
  [string]$HostAlias = 'pizzahut-qa',
  [string]$ExpectedHostname = 'uqphorders24-dev',
  [string]$RemoteName = 'qa'
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')

$remoteHost = (& ssh.exe $HostAlias hostname).Trim()
if ($remoteHost -ne $ExpectedHostname) { throw "Destino inesperado '$remoteHost'; esperado '$ExpectedHostname'." }

$hook = (Get-Content -Raw (Join-Path $PSScriptRoot 'post-receive')) -replace "`r", ''
$hookBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($hook))
$remote = @"
set -euo pipefail
install -d -m 750 /opt/zeroops /var/log/zeroops /var/backups/zeroops
[ -d /opt/zeroops/repo.git ] || git init -q --bare /opt/zeroops/repo.git
git --git-dir=/opt/zeroops/repo.git symbolic-ref HEAD refs/heads/main
echo '$hookBase64' | base64 -d > /opt/zeroops/repo.git/hooks/post-receive
chmod 750 /opt/zeroops/repo.git/hooks/post-receive
cat > /etc/logrotate.d/zeroops-deploy <<'ROT'
/var/log/zeroops/deploy.log {
  weekly
  rotate 8
  compress
  delaycompress
  missingok
  notifempty
  create 640 root root
}
ROT
echo "Repositorio QA pronto: /opt/zeroops/repo.git"
"@
$ErrorActionPreference = 'Continue'
$remote | & ssh.exe $HostAlias "tr -d '\r' | bash"
if ($LASTEXITCODE -ne 0) { throw 'Configuracao remota falhou.' }
$ErrorActionPreference = 'Stop'

Push-Location $root
try {
  $existing = (& git remote) -split "`n"
  if ($existing -notcontains $RemoteName) { & git remote add $RemoteName "${HostAlias}:/opt/zeroops/repo.git" }
  Write-Host "Remote '$RemoteName' configurado. Publicar: git push $RemoteName main"
} finally { Pop-Location }

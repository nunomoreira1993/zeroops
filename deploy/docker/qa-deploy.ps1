#requires -Version 5.1
<#
  Publica o ZeroOps em Qualidade (uqphorders24-dev) com Docker.
  - Envia o codigo local (sem node_modules/dist/.git) para /opt/zeroops/src.
  - Cria /etc/zeroops/zeroops.env apenas se nao existir (password lida de /root/.zeroops/zeroops-mysql.cnf
    no proprio servidor; chave de identidade gerada no servidor). Nenhum segredo passa por este terminal.
  - Constroi as imagens, aplica migracoes e (re)arranca api, worker, connectors e executor.
  Nunca usar contra Producao.
#>
param(
  [string]$HostAlias = 'pizzahut-qa',
  [string]$ExpectedHostname = 'uqphorders24-dev'
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')

$remoteHost = (& ssh.exe $HostAlias hostname).Trim()
if ($remoteHost -ne $ExpectedHostname) { throw "Destino inesperado '$remoteHost'; esperado '$ExpectedHostname'." }

$archive = Join-Path $env:TEMP "zeroops-src-$(Get-Date -Format yyyyMMddHHmmss).tar.gz"
& tar.exe -czf $archive -C $root --exclude=node_modules --exclude=dist --exclude=dist-browser --exclude=.git --exclude=apps/web/dist --exclude=test-results .
if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o pacote.' }
try {
  & scp.exe -q $archive "${HostAlias}:/tmp/zeroops-src.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao enviar o pacote.' }
} finally { Remove-Item $archive -Force }

$remote = @'
set -euo pipefail
install -d -m 750 /opt/zeroops /etc/zeroops
rm -rf /opt/zeroops/src.new && mkdir /opt/zeroops/src.new
tar -xzf /tmp/zeroops-src.tar.gz -C /opt/zeroops/src.new && rm -f /tmp/zeroops-src.tar.gz
rm -rf /opt/zeroops/src.prev; [ -d /opt/zeroops/src ] && mv /opt/zeroops/src /opt/zeroops/src.prev
mv /opt/zeroops/src.new /opt/zeroops/src

if [ ! -f /etc/zeroops/zeroops.env ]; then
  umask 077
  python3 - <<'PY' > /etc/zeroops/zeroops.env
import configparser, urllib.parse, base64, os
c = configparser.ConfigParser(); c.read('/root/.zeroops/zeroops-mysql.cnf')
s = c['client']
user = s.get('user', 'zeroops'); pw = s.get('password', '').strip('"\'')
db = s.get('database', 'zeroops')
q = lambda v: urllib.parse.quote(v, safe='')
print('ZEROOPS_ENVIRONMENT=quality')
print('ZEROOPS_PUBLIC_URL=http://127.0.0.1:4311')
print('ZEROOPS_PORT=4311')
print(f'ZEROOPS_DATABASE_URL=mysql://{q(user)}:{q(pw)}@127.0.0.1:3306/{q(db)}')
print('ZEROOPS_IDENTITY_KEY=' + base64.b64encode(os.urandom(32)).decode())
PY
  chmod 600 /etc/zeroops/zeroops.env
  echo "Criado /etc/zeroops/zeroops.env"
fi

cd /opt/zeroops/src/deploy/docker
export ZEROOPS_IMAGE_TAG=$(date +%Y%m%d%H%M%S)
docker compose build --quiet api executor
docker tag zeroops:$ZEROOPS_IMAGE_TAG zeroops:latest
docker tag zeroops-executor:$ZEROOPS_IMAGE_TAG zeroops-executor:latest
export ZEROOPS_IMAGE_TAG=latest
docker compose run --rm -T migrate </dev/null
docker compose up -d api worker connectors executor
for i in $(seq 1 30); do
  if curl -fsS -o /dev/null http://127.0.0.1:4311/; then echo "API ativa em 127.0.0.1:4311"; break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:4312/v1/health && echo " <- conectores"
docker compose ps
docker image prune -f >/dev/null
'@
# Docker escreve progresso no stderr; no PowerShell 5.1 isso nao pode abortar o deploy.
$ErrorActionPreference = 'Continue'
$remote | & ssh.exe $HostAlias "tr -d '\r' | bash"
if ($LASTEXITCODE -ne 0) { throw 'Deploy remoto falhou.' }
Write-Host "Acesso: https://tickets.pizzahut.pt (hosts + CA de QA) ou ssh -N -L 4311:127.0.0.1:4311 $HostAlias"

#requires -Version 5.1
<#
  Publica o ZeroOps de Qualidade em https://tickets.pizzahut.pt.
  No servidor de Qualidade (uqphorders24-dev):
    - cria uma CA de Qualidade limitada por nameConstraints a tickets.pizzahut.pt e emite o certificado do portal;
    - instala o vhost deploy/apache/tickets.pizzahut.pt.conf, ativa proxy_http e valida a configuracao;
    - atualiza ZEROOPS_PUBLIC_URL/ZEROOPS_TRUST_LOOPBACK_PROXY em /etc/zeroops/zeroops.env e recria a API.
  Nesta maquina (pede elevacao UAC):
    - aponta tickets.pizzahut.pt para o IP de Qualidade no ficheiro hosts;
    - confia a CA de Qualidade (restrita a tickets.pizzahut.pt) no repositorio da maquina.
  Nunca usar contra Producao. Nenhum segredo passa por este terminal.
#>
param(
  [string]$HostAlias = 'pizzahut-qa',
  [string]$ExpectedHostname = 'uqphorders24-dev',
  [string]$ServerIp = '192.168.90.79',
  [string]$Domain = 'tickets.pizzahut.pt',
  [switch]$SkipServer,
  [switch]$SkipLocal
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$certPath = Join-Path $env:LOCALAPPDATA "ZeroOps\$Domain-qa-ca.crt"

if (-not $SkipServer) {
  $remoteHost = (& ssh.exe $HostAlias hostname).Trim()
  if ($remoteHost -ne $ExpectedHostname) { throw "Destino inesperado '$remoteHost'; esperado '$ExpectedHostname'." }
  & scp.exe -q (Join-Path $root "deploy\apache\$Domain.conf") "${HostAlias}:/tmp/zeroops-vhost.conf"
  if ($LASTEXITCODE -ne 0) { throw 'Falha ao enviar o vhost.' }

  $remote = @'
set -euo pipefail
DOMAIN=__DOMAIN__
install -d -m 755 /etc/certs
CA=/etc/certs/zeroops-qa-ca; LEAF=/etc/certs/zeroops-tickets
if ! openssl verify -CAfile $CA.crt $CA.crt >/dev/null 2>&1; then
  umask 077
  # CA restrita por nameConstraints: so pode emitir para o dominio do portal.
  printf '[req]\ndistinguished_name=dn\nx509_extensions=ca\nprompt=no\n[dn]\n[ca]\nsubjectKeyIdentifier=hash\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nnameConstraints=critical,permitted;DNS:%s\n' "$DOMAIN" > /tmp/zeroops-ca.cnf
  openssl req -x509 -config /tmp/zeroops-ca.cnf -newkey rsa:2048 -nodes -days 3650 -sha256 \
    -keyout $CA.key -out $CA.crt -subj "/O=Pizza Hut/OU=ZeroOps Qualidade/CN=ZeroOps QA CA ($DOMAIN)" 2>/dev/null
  rm -f /tmp/zeroops-ca.cnf
  chmod 600 $CA.key; chmod 644 $CA.crt
  echo "CA de Qualidade criada para $DOMAIN"
fi
if ! openssl verify -CAfile $CA.crt $LEAF.crt >/dev/null 2>&1; then
  umask 077
  printf 'subjectAltName=DNS:%s\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n' "$DOMAIN" > /tmp/zeroops-leaf.ext
  openssl req -new -newkey rsa:2048 -nodes -keyout $LEAF.key -out /tmp/zeroops-leaf.csr \
    -subj "/O=Pizza Hut/OU=ZeroOps Qualidade/CN=$DOMAIN" 2>/dev/null
  openssl x509 -req -in /tmp/zeroops-leaf.csr -CA $CA.crt -CAkey $CA.key -CAcreateserial \
    -CAserial /etc/certs/zeroops-qa-ca.srl -days 397 -sha256 -extfile /tmp/zeroops-leaf.ext -out $LEAF.crt 2>/dev/null
  rm -f /tmp/zeroops-leaf.csr /tmp/zeroops-leaf.ext
  chmod 600 $LEAF.key; chmod 644 $LEAF.crt
  echo "Certificado de $DOMAIN emitido pela CA de Qualidade"
fi
install -m 644 /tmp/zeroops-vhost.conf /etc/apache2/sites-available/$DOMAIN.conf && rm -f /tmp/zeroops-vhost.conf
a2enmod -q proxy proxy_http headers ssl >/dev/null
a2ensite -q $DOMAIN >/dev/null
if ! apache2ctl configtest >/dev/null 2>&1; then
  a2dissite -q $DOMAIN >/dev/null
  apache2ctl configtest 2>&1 || true
  echo "Configuracao Apache invalida; vhost desativado."; exit 1
fi
systemctl reload apache2

ENV=/etc/zeroops/zeroops.env
cp -p $ENV $ENV.bak
sed -i "s#^ZEROOPS_PUBLIC_URL=.*#ZEROOPS_PUBLIC_URL=https://$DOMAIN#" $ENV
grep -q '^ZEROOPS_TRUST_LOOPBACK_PROXY=' $ENV || echo 'ZEROOPS_TRUST_LOOPBACK_PROXY=true' >> $ENV
cd /opt/zeroops/src/deploy/docker
docker compose up -d --force-recreate api worker >/dev/null 2>&1
for i in $(seq 1 30); do
  if curl -fsSk --resolve $DOMAIN:443:127.0.0.1 -o /dev/null https://$DOMAIN/api/health 2>/dev/null; then
    echo "OK https://$DOMAIN/api/health"; break
  fi
  sleep 2
done
cat /etc/certs/zeroops-qa-ca.crt
'@
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $output = @(($remote -replace '__DOMAIN__', $Domain) | & ssh.exe $HostAlias "tr -d '\r' | bash 2>&1" | ForEach-Object { "$_" })
  $failed = $LASTEXITCODE -ne 0
  $ErrorActionPreference = $previousPreference
  $begin = [Array]::IndexOf($output, '-----BEGIN CERTIFICATE-----')
  $output | Select-Object -First $(if ($begin -ge 0) { $begin } else { $output.Count }) | ForEach-Object { Write-Host $_ }
  if ($failed -or $begin -lt 0) { throw 'Configuracao remota falhou.' }
  New-Item -ItemType Directory -Force (Split-Path $certPath) | Out-Null
  [IO.File]::WriteAllText($certPath, (($output[$begin..($output.Count - 1)] -join "`n").Trim() + "`n"))
  Write-Host "Certificado publico guardado em $certPath"
}

if (-not $SkipLocal) {
  $hostsLine = "$ServerIp $Domain"
  $hostsFile = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
  $public = if (Test-Path $certPath) { New-Object Security.Cryptography.X509Certificates.X509Certificate2 $certPath }
  $hostsReady = Select-String -Path $hostsFile -SimpleMatch $hostsLine -Quiet
  $certReady = -not $public -or (Get-ChildItem Cert:\LocalMachine\Root | Where-Object Thumbprint -eq $public.Thumbprint)
  if (-not $hostsReady -or -not $certReady) {
    # CA com nameConstraints: so e aceite para tickets.pizzahut.pt. Remove certificados antigos do portal.
    $elevated = @"
`$h = "`$env:SystemRoot\System32\drivers\etc\hosts"
`$lines = [IO.File]::ReadAllLines(`$h) | Where-Object { `$_ -notmatch '^\s*[0-9a-fA-F.:]+\s+$([regex]::Escape($Domain))\s*$' }
[IO.File]::WriteAllLines(`$h, @(`$lines) + '$hostsLine')
Get-ChildItem Cert:\LocalMachine\Root | Where-Object { `$_.Subject -like '*OU=ZeroOps Qualidade*' } | Remove-Item
if (Test-Path '$certPath') { Import-Certificate -FilePath '$certPath' -CertStoreLocation Cert:\LocalMachine\Root | Out-Null }
ipconfig /flushdns | Out-Null
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($elevated))
    Write-Host "A pedir elevacao (UAC): hosts '$hostsLine' e confianca no certificado de $Domain..."
    Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden `
      -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $encoded
  }
  if (-not (Select-String -Path $hostsFile -SimpleMatch $hostsLine -Quiet)) {
    throw 'Nao foi possivel atualizar o ficheiro hosts.'
  }
  if ($public -and -not (Get-ChildItem Cert:\LocalMachine\Root | Where-Object Thumbprint -eq $public.Thumbprint)) {
    throw 'O certificado nao ficou confiado nesta maquina.'
  }
  Write-Host "Disponivel em https://$Domain"
}

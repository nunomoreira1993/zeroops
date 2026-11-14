[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9._-]{0,63}$')]
    [string]$UserName = 'root',
    [string]$Alias = 'pizzahut-qa',
    [switch]$ConfigOnly
)

# Configura acesso SSH persistente a Qualidade por chave publica.
# Nenhuma password e lida, impressa ou guardada por este script: o SSH pede-a
# uma unica vez no proprio terminal para instalar a chave em authorized_keys.

$ErrorActionPreference = 'Stop'
$qualityAddress = '192.168.90.79'
$sshDirectory = Join-Path $env:USERPROFILE '.ssh'
$configPath = Join-Path $sshDirectory 'config'
$privateKey = Join-Path $sshDirectory 'id_ed25519'
$publicKey = "$privateKey.pub"

if (-not (Test-Path $publicKey)) {
    throw "Chave publica inexistente: $publicKey. Gere-a com: ssh-keygen -t ed25519"
}

$config = if (Test-Path $configPath) { Get-Content $configPath -Raw } else { '' }
if ($config -notmatch "(?m)^Host\s+$([regex]::Escape($Alias))\s*$") {
    $block = @(
        '',
        "Host $Alias",
        "    HostName $qualityAddress",
        "    User $UserName",
        '    IdentityFile ~/.ssh/id_ed25519',
        '    IdentitiesOnly yes',
        '    BatchMode yes',
        '    StrictHostKeyChecking yes',
        '    ConnectTimeout 15',
        '    ServerAliveInterval 30',
        '    ServerAliveCountMax 3'
    ) -join "`n"
    Add-Content -Path $configPath -Value $block -Encoding ascii
    Write-Host "Alias SSH '$Alias' adicionado a $configPath."
} else {
    Write-Host "Alias SSH '$Alias' ja existe em $configPath."
}

if ($ConfigOnly) { return }

# No Windows PowerShell 5.1, stderr de comandos nativos com 'Stop' aborta o script;
# a partir daqui as falhas do SSH sao avaliadas pelo codigo de saida.
$ErrorActionPreference = 'Continue'
& ssh.exe -o BatchMode=yes $Alias 'true' 2>$null
$probeExitCode = $LASTEXITCODE
if ($probeExitCode -eq 0) {
    Write-Host "A chave ja esta autorizada em $Alias."
} else {
    if ([Console]::IsInputRedirected) {
        throw 'Execute num terminal interativo seu: a password e pedida apenas pelo SSH.'
    }
    Write-Host "A instalar a chave publica em $UserName@$qualityAddress. Introduza a password no prompt SSH (uma unica vez)."
    $remote = 'umask 077; mkdir -p ~/.ssh; key=$(tr -d "\r"); grep -qxF "$key" ~/.ssh/authorized_keys 2>/dev/null || echo "$key" >> ~/.ssh/authorized_keys'
    Get-Content $publicKey -Raw | & ssh.exe -o BatchMode=no -o PubkeyAuthentication=no -o StrictHostKeyChecking=yes "$UserName@$qualityAddress" $remote
    if ($LASTEXITCODE -ne 0) { throw "Falha a instalar a chave (codigo $LASTEXITCODE)." }
}

$check = "printf '%s|%s|' `"`$(hostname)`" `"`$(id -un)`"; mysql --version 2>/dev/null || mariadb --version 2>/dev/null"
# O pipe do PowerShell acrescenta CRLF; o comando remoto e lido por stdin para evitar perder aspas.
$identity = $check | & ssh.exe $Alias "tr -d '\r' | bash"
if ($LASTEXITCODE -ne 0) { throw 'A verificacao sem password falhou.' }
Write-Host "Verificado (hostname|utilizador|mysql): $identity"
Write-Host "A partir de agora: ssh $Alias"

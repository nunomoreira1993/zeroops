[CmdletBinding()]
param(
    [ValidatePattern('^[a-zA-Z_][a-zA-Z0-9._-]{0,63}$')]
    [string]$UserName,
    [switch]$PrintCommand
)

$ErrorActionPreference = 'Stop'
$qualityAddress = '192.168.90.79'
$expectedHostName = 'uqphorders24-dev'
$ssh = Get-Command ssh.exe -CommandType Application -ErrorAction Stop

if ([string]::IsNullOrWhiteSpace($UserName)) {
    if ($PrintCommand) {
        throw 'Indique -UserName com o utilizador individual autorizado de Qualidade.'
    }
    if ([Console]::IsInputRedirected) {
        throw 'Execute este script num terminal interativo que controla.'
    }
    $UserName = Read-Host 'Utilizador individual autorizado de Qualidade'
}


$sshArguments = @(
    '-o', 'BatchMode=no',
    '-o', 'StrictHostKeyChecking=ask',
    '-o', 'ConnectTimeout=15',
    '-o', 'NumberOfPasswordPrompts=3',
    '-p', '22',
    "$UserName@$qualityAddress"
)

Write-Host "Destino QA indicado: $qualityAddress; hostname esperado: $expectedHostName."
Write-Host 'O hostname e os caminhos ainda precisam de confirmacao apos autenticar.'
Write-Host 'Confirme a fingerprint com a infraestrutura antes de aceitar uma chave nova.'

if ($PrintCommand) {
    Write-Output ("ssh.exe " + ($sshArguments -join ' '))
    return
}

if ([Console]::IsInputRedirected) {
    throw 'Execute num terminal interativo seu. A password deve ser introduzida apenas no prompt SSH.'
}

Write-Host 'O SSH usa a chave/agent existente ou pede a password no proprio terminal.'
Write-Host 'Ao escrever a password, nao aparecem caracteres. Este script nao a le nem a guarda.'
Write-Host 'Depois do login, execute hostname, pwd e id. Nao execute updates ou instalacoes nesta fase.'
& $ssh.Source @sshArguments
if ($LASTEXITCODE -ne 0) {
    throw "A sessao SSH terminou com codigo $LASTEXITCODE. Nenhuma instalacao foi executada pelo script."
}

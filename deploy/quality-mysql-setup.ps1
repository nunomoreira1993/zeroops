[CmdletBinding()]
param(
    [string]$Alias = 'pizzahut-qa',
    [string]$SitePath = '/var/www/vhosts/pizzahut.pt/httpdocs'
)

# Configura em Qualidade dois acessos MySQL usados pelo ZeroOps/Copilot:
#  1. root   -> /root/.my.cnf (gestao da BD do ZeroOps). A password e escrita por si num
#               ficheiro local temporario, enviada por SSH (stdin) e o ficheiro local e apagado.
#  2. site   -> /root/.zeroops/site-mysql.cnf, gerado no proprio servidor a partir de
#               lib/db.config.credentials.php (a password do site nunca sai do servidor).
#  3. zeroops-> BD `zeroops` e utilizador `zeroops@localhost` (sql/zeroops_database_provision.sql),
#               com password gerada no servidor em /root/.zeroops/zeroops-mysql.cnf.
# Nenhuma password e impressa, passada em argumentos ou guardada nos repositorios.

$ErrorActionPreference = 'Continue'
$localDirectory = Join-Path $env:USERPROFILE '.zeroops'
$rootFile = Join-Path $localDirectory 'qa-mysql-root.cnf'

function Invoke-Remote([string]$Script) {
    # Os comandos seguem por stdin: no Windows PowerShell as aspas dos argumentos do ssh perdem-se.
    $Script | & ssh.exe $Alias "tr -d '\r' | bash" | Out-Host
    return $LASTEXITCODE
}

function New-RootTemplate {
    New-Item -ItemType Directory -Force $localDirectory | Out-Null
    Set-Content -Path $rootFile -Encoding ascii -Value @(
        '# Preencha a password do root MySQL de Qualidade e volte a correr quality-mysql-setup.ps1.',
        '# Use aspas se a password tiver espacos, # ou ; (ex.: password="a#b"). Este ficheiro e apagado apos o envio.',
        '[client]',
        'user=root',
        'password='
    )
    & icacls.exe $rootFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}

function Install-RootCredential {
    $content = (Get-Content $rootFile | Where-Object { $_ -notmatch '^\s*#' }) -join "`n"
    if ($content -notmatch '(?m)^password=\S') {
        throw "Password ainda vazia em $rootFile. Preencha-a e volte a correr este script."
    }
    if ($content -match 'ZEROOPS_EOF') { throw 'Conteudo invalido.' }
    $rootScript = @"
umask 077
cat > /root/.my.cnf.new <<'ZEROOPS_EOF'
$content
ZEROOPS_EOF
if mysql --defaults-file=/root/.my.cnf.new -N -e 'SELECT 1' >/dev/null 2>&1; then
  [ -f /root/.my.cnf ] && cp -p /root/.my.cnf /root/.my.cnf.bak-zeroops
  mv /root/.my.cnf.new /root/.my.cnf
  chmod 600 /root/.my.cnf
  mysql -N -e 'SELECT CONCAT("root OK: ", CURRENT_USER())'
else
  rm -f /root/.my.cnf.new
  echo 'Password root rejeitada pelo MySQL; /root/.my.cnf nao foi alterado.' >&2
  exit 3
fi
"@
    $code = Invoke-Remote $rootScript
    if ($code -ne 0) {
        throw "Password root nao validada (codigo $code). Corrija $rootFile e volte a correr."
    }
    Remove-Item -Force $rootFile
    Write-Host 'Credencial root instalada em /root/.my.cnf (600). Ficheiro local apagado.'
}

Write-Host '== Acesso MySQL do site (utilizador da aplicacao) =='
$siteScript = @"
set -e
umask 077
mkdir -p /root/.zeroops
cd '$SitePath'
php -d display_errors=0 -r '
`$_SERVER["DOCUMENT_ROOT"]=getcwd(); `$_SERVER["HTTP_HOST"]="devpizzahut.uq.pt"; define("ENV_PH_SITE","backend");
include "lib/db.config.credentials.php"; `$c=`$cfg_mysql[1];
if (!in_array(`$c["server"], ["localhost","127.0.0.1"], true)) { fwrite(STDERR, "Servidor MySQL do site nao e local; abortado.\n"); exit(2); }
`$q=function(`$v){return "\"".addcslashes(`$v,"\\\\\"")."\"";};
file_put_contents("/root/.zeroops/site-mysql.cnf", "[client]\nhost=".`$q(`$c["server"])."\nuser=".`$q(`$c["user"])."\npassword=".`$q(`$c["pass"])."\ndatabase=".`$q(`$c["db"])."\n");'
chmod 600 /root/.zeroops/site-mysql.cnf
mysql --defaults-file=/root/.zeroops/site-mysql.cnf -N -e 'SELECT CONCAT("site OK: ", CURRENT_USER(), " / ", DATABASE())'
"@
if ((Invoke-Remote $siteScript) -ne 0) { throw 'Falha a configurar o acesso MySQL do site.' }

Write-Host '== Acesso MySQL root (gestao da BD do ZeroOps) =='
if (-not (Test-Path $rootFile)) {
    if ((Invoke-Remote "mysql -N -e 'SELECT CONCAT(""root OK: "", CURRENT_USER())'") -ne 0) {
        New-RootTemplate
        Write-Host "/root/.my.cnf em QA nao funciona. Criado $rootFile (so o seu utilizador Windows o pode ler)."
        Write-Host 'Preencha a password e volte a correr este script.'
        return
    }
} else {
    Install-RootCredential
}

Write-Host '== BD e utilizador do ZeroOps =='
# Equivalente a sql/zeroops_database_provision.sql; a password e gerada no servidor e nao sai de la.
$zeroopsScript = @'
set -e
umask 077
cnf=/root/.zeroops/zeroops-mysql.cnf
mkdir -p /root/.zeroops
if [ ! -f "$cnf" ]; then
  pass=$(openssl rand -hex 24)
  printf '[client]\nhost=localhost\nuser=zeroops\npassword=%s\ndatabase=zeroops\n' "$pass" > "$cnf.new"
  mysql -e "CREATE DATABASE IF NOT EXISTS zeroops CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
    CREATE USER IF NOT EXISTS 'zeroops'@'localhost' IDENTIFIED BY '$pass';
    ALTER USER 'zeroops'@'localhost' IDENTIFIED BY '$pass';"
  unset pass
  mv "$cnf.new" "$cnf"
fi
chmod 600 "$cnf"
mysql -e "CREATE DATABASE IF NOT EXISTS zeroops CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
  GRANT ALL PRIVILEGES ON zeroops.* TO 'zeroops'@'localhost'; FLUSH PRIVILEGES;"
mysql --defaults-file="$cnf" -N -e 'SELECT CONCAT("zeroops OK: ", CURRENT_USER(), " / ", DATABASE())'
'@
if ((Invoke-Remote $zeroopsScript) -ne 0) { throw 'Falha a provisionar a BD do ZeroOps.' }

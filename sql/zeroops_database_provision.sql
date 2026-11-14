-- Provisionamento da BD do ZeroOps em MySQL/MariaDB (QA e Producao).
-- Executar como root. Idempotente. Nao e uma migracao (o migrador so le ficheiros NNN_*.sql).
-- Substituir <PASSWORD_GERADA> por uma password aleatoria gerada no proprio servidor; nunca a versionar.
-- Em QA, deploy/quality-mysql-setup.ps1 aplica estas queries e guarda a credencial em /root/.zeroops/zeroops-mysql.cnf.

CREATE DATABASE IF NOT EXISTS `zeroops` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE USER IF NOT EXISTS 'zeroops'@'localhost' IDENTIFIED BY '<PASSWORD_GERADA>';

GRANT ALL PRIVILEGES ON `zeroops`.* TO 'zeroops'@'localhost';

FLUSH PRIVILEGES;

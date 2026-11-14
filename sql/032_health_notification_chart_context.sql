-- Associacao imutavel entre a notificacao e os graficos/recursos da ocorrencia.
-- Migracao aditiva e idempotente para MariaDB 10.3.
ALTER TABLE health_notifications
  ADD COLUMN IF NOT EXISTS chart_context LONGTEXT NULL
    CHECK (chart_context IS NULL OR JSON_VALID(chart_context));

-- Sem backfill: labels de health_external_alerts e estados das verificacoes sao
-- mutaveis e nao comprovam o recurso de uma notificacao historica.
-- Emails anteriores conservam NULL e continuam no historico, sem linhas amarelas.

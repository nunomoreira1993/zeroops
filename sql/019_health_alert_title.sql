-- Titulo legivel do alerta (anotacao `title` da regra, ex.: «MySQL indisponivel»), usado no
-- relatorio do incidente, na mensagem ao cliente e nas resolucoes feitas por reconciliacao.
-- Idempotente; alertas anteriores ficam sem titulo e usam o nome tecnico.

ALTER TABLE health_external_alerts
  ADD COLUMN IF NOT EXISTS title VARCHAR(160) NULL AFTER alert_name;

-- Valor da metrica de cada alerta no disparo e na recuperacao (ex.: «Indisponível (0)» e
-- «Disponível (1)», «4,2 %» e «18,5 %»), lido do Prometheus quando o incidente recupera e
-- mostrado no relatorio do incidente e na mensagem final ao cliente.
-- Idempotente; alertas anteriores ficam sem valores e o relatorio mostra «—».

ALTER TABLE health_external_alerts
  ADD COLUMN IF NOT EXISTS metric_before VARCHAR(60) NULL AFTER summary,
  ADD COLUMN IF NOT EXISTS metric_after VARCHAR(60) NULL AFTER metric_before;

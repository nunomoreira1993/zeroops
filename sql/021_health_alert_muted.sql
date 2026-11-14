-- Alertas do Prometheus recebidos durante uma paragem planeada do projeto (Saude -> Configuracao):
-- ficam registados mas sem e-mail nem ticket (`muted` = 1). Se ainda estiverem ativos quando a
-- paragem termina, o ZeroOps notifica nessa altura e repoe `muted` = 0.
-- Idempotente; alertas anteriores ficam com 0.

ALTER TABLE health_external_alerts
  ADD COLUMN IF NOT EXISTS muted TINYINT(1) NOT NULL DEFAULT 0 AFTER state;

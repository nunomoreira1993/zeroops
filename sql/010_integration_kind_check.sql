-- Corrige a 009: em MariaDB o CHECK em linha da coluna `kind` nao sai com DROP CONSTRAINT;
-- so desaparece ao redefinir a coluna. A validacao passa a ser feita apenas pelo CHECK nomeado
-- `integration_settings_kind_check` (que ja inclui `metrics`). Idempotente.
ALTER TABLE integration_settings MODIFY kind VARCHAR(20) NOT NULL;

ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_kind_check;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_kind_check
  CHECK (kind IN ('smtp', 'svn', 'documentation', 'telemetry', 'metrics', 'database', 'copilot', 'sandbox', 'deployment'));

-- Remove a configuração Sandbox: era apenas uma referência e não tinha conector executável.
-- A decisão foi aprovada pelo responsável do projeto; elimina apenas as configurações desta opção.
DELETE FROM integration_settings WHERE kind='sandbox';

-- Em MariaDB, redefinir a coluna remove o CHECK inline antes de repor o CHECK nomeado.
ALTER TABLE integration_settings MODIFY kind VARCHAR(20) NOT NULL;
ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_kind_check;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_kind_check
  CHECK (kind IN ('smtp', 'svn', 'documentation', 'telemetry', 'metrics', 'database', 'copilot', 'deployment'));

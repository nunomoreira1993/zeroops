-- Perfis de selecao do executor e nivel Fusion. Idempotente; preserva runs antigos.
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS execution_mode VARCHAR(10) CHARACTER SET ascii NOT NULL DEFAULT 'copilot',
  ADD COLUMN IF NOT EXISTS fusion_tier VARCHAR(10) CHARACTER SET ascii NULL;

-- Metadados de routing anunciados pelo runtime, separados dos modelos individuais.
ALTER TABLE agent_model_catalogs
  ADD COLUMN IF NOT EXISTS routing_tiers JSON NULL;

-- Pedir nova descoberta; nao apagar a ultima lista conhecida.
UPDATE agent_model_catalogs SET refresh_requested_at=NOW(3);

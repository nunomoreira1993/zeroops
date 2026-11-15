-- Entrega A / F03: locks canónicos sobre os recursos reais.
-- Aditiva e idempotente. `integration_key` é preenchida pelo executor/serviço (hash do URL
-- normalizado + branch); entregas antigas sem chave continuam a usar o par repositório/branch.
ALTER TABLE delivery_runs
  ADD COLUMN IF NOT EXISTS integration_key VARCHAR(80) CHARACTER SET ascii NULL;

CREATE INDEX IF NOT EXISTS delivery_runs_integration_queue_idx
  ON delivery_runs (integration_key, finished_at, state, created_at);

-- Identificador explícito do ambiente real servido pela pipeline: pipelines diferentes com o
-- mesmo valor partilham o lock de publicação (p.ex. endpoints distintos para o mesmo QA).
ALTER TABLE project_pipelines
  ADD COLUMN IF NOT EXISTS target_key VARCHAR(200) NULL;

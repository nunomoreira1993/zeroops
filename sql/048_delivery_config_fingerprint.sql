-- Entrega A / F01: destino material fixado na criação da entrega.
-- Aditiva e idempotente. `config_fingerprint` é o SHA-256 (sem segredos) da pipeline, repositório
-- real, branch, ambiente, endpoint e alvo canónico; entregas anteriores ficam NULL e fixam-no na
-- primeira posse pelo executor. Uma configuração diferente bloqueia a entrega em vez de a
-- redirecionar.
ALTER TABLE delivery_runs
  ADD COLUMN IF NOT EXISTS config_fingerprint CHAR(64) CHARACTER SET ascii NULL;

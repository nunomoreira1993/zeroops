-- Conectores de leitura usados pelo agente. Cada run em execucao recebe um token proprio (so o hash
-- fica guardado) e cada chamada fica registada como evidencia auditavel.
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS connector_token_hash CHAR(64) CHARACTER SET ascii NULL,
  ADD UNIQUE KEY IF NOT EXISTS agent_runs_connector_token (connector_token_hash);

CREATE TABLE IF NOT EXISTS agent_run_tool_calls (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  run_id CHAR(36) CHARACTER SET ascii NOT NULL,
  tool VARCHAR(40) NOT NULL,
  request TEXT NOT NULL,
  outcome VARCHAR(20) NOT NULL CHECK (outcome IN ('ok', 'rejected', 'error')),
  row_count INT NULL,
  duration_ms INT NOT NULL,
  error_code VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY agent_run_tool_calls_run (run_id, created_at),
  CONSTRAINT agent_run_tool_calls_run_fk FOREIGN KEY (run_id) REFERENCES agent_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

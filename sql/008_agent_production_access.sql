-- Instrucoes do agente por projeto (versionadas) e acesso de leitura a Producao atraves do relay
-- instalado no servidor de Producao (a rede so permite Producao -> ZeroOps por HTTPS).

CREATE TABLE IF NOT EXISTS project_agent_instructions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  version INT UNSIGNED NOT NULL,
  body TEXT NOT NULL CHECK (CHAR_LENGTH(body) <= 20000),
  created_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY project_agent_instructions_version (project_id, version),
  CONSTRAINT project_agent_instructions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT project_agent_instructions_author_fk FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ambiente consultado em cada chamada de conector (evidencia do run).
ALTER TABLE agent_run_tool_calls
  ADD COLUMN IF NOT EXISTS environment VARCHAR(20) NOT NULL DEFAULT 'quality' AFTER tool;

-- Um relay por projeto: so o hash do token fica guardado.
CREATE TABLE IF NOT EXISTS connector_relays (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  token_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  hostname VARCHAR(255) NULL,
  version VARCHAR(40) NULL,
  last_seen_at DATETIME(3) NULL,
  rotated_by CHAR(36) CHARACTER SET ascii NULL,
  rotated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY connector_relays_token (token_hash),
  CONSTRAINT connector_relays_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fila de chamadas a executar pelo relay; o resultado volta pela mesma linha.
CREATE TABLE IF NOT EXISTS connector_relay_requests (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  run_id CHAR(36) CHARACTER SET ascii NULL,
  tool VARCHAR(40) NOT NULL,
  payload LONGTEXT NOT NULL CHECK (JSON_VALID(payload)),
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'expired')),
  result LONGTEXT NULL CHECK (result IS NULL OR JSON_VALID(result)),
  error_code VARCHAR(60) NULL,
  error_message VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  claimed_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  KEY connector_relay_requests_pending (project_id, status, created_at),
  CONSTRAINT connector_relay_requests_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT connector_relay_requests_run_fk FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

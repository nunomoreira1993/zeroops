-- Conversa ao vivo com o agente: eventos publicados pelo executor (texto em streaming, ferramentas,
-- servidores MCP, perguntas) e entradas da equipa (respostas e mensagens de seguimento).
CREATE TABLE IF NOT EXISTS agent_run_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  run_id CHAR(36) CHARACTER SET ascii NOT NULL,
  type VARCHAR(40) NOT NULL,
  payload LONGTEXT NOT NULL CHECK (JSON_VALID(payload)),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY agent_run_events_run (run_id, id),
  CONSTRAINT agent_run_events_run_fk FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS agent_run_inputs (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  run_id CHAR(36) CHARACTER SET ascii NOT NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('answer', 'message')),
  question_id VARCHAR(100) NULL,
  body TEXT NOT NULL CHECK (CHAR_LENGTH(body) <= 4000),
  author_id CHAR(36) CHARACTER SET ascii NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  consumed_at DATETIME(3) NULL,
  KEY agent_run_inputs_pending (run_id, consumed_at, created_at),
  CONSTRAINT agent_run_inputs_run_fk FOREIGN KEY (run_id) REFERENCES agent_runs(id) ON DELETE CASCADE,
  CONSTRAINT agent_run_inputs_author_fk FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

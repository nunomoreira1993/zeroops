-- P06: chat de construcao de fluxos com diagrama em tempo real.
-- `flow_authoring_sessions`: sessao de autoria persistente por fluxo e utilizador (modo assistido
-- ou automatico); o estado da construcao vive na BD, nao na sessao Copilot nem no browser.
-- `flow_authoring_operations`: cada lote de operacoes tipadas (aplicado, proposto, rejeitado, em
-- conflito, desfeito) com ator, sessao, revisao-base e revisao resultante; desfazer cria uma nova
-- linha e nunca apaga historico.
-- `flow_authoring_events`: eventos persistentes com cursor (id crescente) para SSE/replay/polling.
-- `flow_capability_requests`: capacidades em falta pedidas durante a construcao (P10 trata depois).
-- Aditiva e idempotente; pedidos antigos do assistente continuam validos (sem sessao).

CREATE TABLE IF NOT EXISTS flow_authoring_sessions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  created_by CHAR(36) CHARACTER SET ascii NOT NULL,
  mode VARCHAR(10) CHARACTER SET ascii NOT NULL DEFAULT 'assisted',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT flow_authoring_sessions_mode_check CHECK (mode IN ('assisted', 'auto')),
  UNIQUE KEY flow_authoring_sessions_owner (flow_id, created_by),
  KEY flow_authoring_sessions_project (project_id),
  CONSTRAINT flow_authoring_sessions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT flow_authoring_sessions_flow_fk FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE,
  CONSTRAINT flow_authoring_sessions_user_fk FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_authoring_operations (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  session_id CHAR(36) CHARACTER SET ascii NULL,
  request_id CHAR(36) CHARACTER SET ascii NULL,
  actor_id CHAR(36) CHARACTER SET ascii NOT NULL,
  source VARCHAR(12) CHARACTER SET ascii NOT NULL,
  kind VARCHAR(12) CHARACTER SET ascii NOT NULL DEFAULT 'definition',
  status VARCHAR(12) CHARACTER SET ascii NOT NULL,
  base_revision INT NOT NULL,
  result_revision INT NULL,
  operations LONGTEXT NULL CHECK (operations IS NULL OR JSON_VALID(operations)),
  routing LONGTEXT NULL CHECK (routing IS NULL OR JSON_VALID(routing)),
  summary VARCHAR(400) NOT NULL DEFAULT '',
  definition_before LONGTEXT NULL CHECK (definition_before IS NULL OR JSON_VALID(definition_before)),
  definition_after LONGTEXT NULL CHECK (definition_after IS NULL OR JSON_VALID(definition_after)),
  routing_before LONGTEXT NULL CHECK (routing_before IS NULL OR JSON_VALID(routing_before)),
  routing_after LONGTEXT NULL CHECK (routing_after IS NULL OR JSON_VALID(routing_after)),
  error VARCHAR(600) NULL,
  undo_of CHAR(36) CHARACTER SET ascii NULL,
  undone_by CHAR(36) CHARACTER SET ascii NULL,
  idempotency_key VARCHAR(200) CHARACTER SET ascii NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT flow_authoring_operations_source_check CHECK (source IN ('assistant', 'accept', 'undo')),
  CONSTRAINT flow_authoring_operations_kind_check CHECK (kind IN ('definition', 'routing')),
  CONSTRAINT flow_authoring_operations_status_check
    CHECK (status IN ('applied', 'proposed', 'rejected', 'conflict', 'accepted', 'discarded')),
  UNIQUE KEY flow_authoring_operations_idempotency (idempotency_key),
  KEY flow_authoring_operations_flow (flow_id, created_at),
  KEY flow_authoring_operations_request (request_id, created_at),
  CONSTRAINT flow_authoring_operations_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT flow_authoring_operations_flow_fk FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_authoring_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  session_id CHAR(36) CHARACTER SET ascii NULL,
  request_id CHAR(36) CHARACTER SET ascii NULL,
  actor_id CHAR(36) CHARACTER SET ascii NULL,
  event_type VARCHAR(40) CHARACTER SET ascii NOT NULL,
  payload LONGTEXT NOT NULL CHECK (JSON_VALID(payload)),
  idempotency_key VARCHAR(200) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY flow_authoring_events_idempotency (idempotency_key),
  KEY flow_authoring_events_flow (flow_id, id),
  CONSTRAINT flow_authoring_events_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT flow_authoring_events_flow_fk FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_capability_requests (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  session_id CHAR(36) CHARACTER SET ascii NULL,
  request_id CHAR(36) CHARACTER SET ascii NULL,
  requested_by CHAR(36) CHARACTER SET ascii NOT NULL,
  capability_kind VARCHAR(20) CHARACTER SET ascii NOT NULL,
  capability VARCHAR(120) NOT NULL,
  reason TEXT NOT NULL,
  node_id VARCHAR(64) CHARACTER SET ascii NULL,
  status VARCHAR(12) CHARACTER SET ascii NOT NULL DEFAULT 'open',
  idempotency_key VARCHAR(200) CHARACTER SET ascii NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT flow_capability_requests_kind_check
    CHECK (capability_kind IN ('tool', 'integration', 'agent', 'skill', 'other')),
  CONSTRAINT flow_capability_requests_status_check CHECK (status IN ('open', 'dismissed')),
  UNIQUE KEY flow_capability_requests_idempotency (idempotency_key),
  KEY flow_capability_requests_flow (flow_id, status),
  CONSTRAINT flow_capability_requests_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT flow_capability_requests_flow_fk FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE flow_assistant_requests
  ADD COLUMN IF NOT EXISTS session_id CHAR(36) CHARACTER SET ascii NULL,
  ADD COLUMN IF NOT EXISTS authoring_mode VARCHAR(10) CHARACTER SET ascii NULL,
  ADD COLUMN IF NOT EXISTS known_revision INT NULL;

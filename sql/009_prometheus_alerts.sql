-- Integracao Prometheus (kind `metrics`) e alertas recebidos do Alertmanager, com ligacao ao
-- ticket aberto automaticamente para alertas criticos. Idempotente.

-- O CHECK em linha da coluna `kind` chama-se `kind` em MariaDB; e substituido por um nomeado.
ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS kind;
ALTER TABLE integration_settings DROP CONSTRAINT IF EXISTS integration_settings_kind_check;
ALTER TABLE integration_settings ADD CONSTRAINT integration_settings_kind_check
  CHECK (kind IN ('smtp', 'svn', 'documentation', 'telemetry', 'metrics', 'database', 'copilot', 'sandbox', 'deployment'));

CREATE TABLE IF NOT EXISTS health_external_alerts (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  source VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'alertmanager',
  fingerprint VARCHAR(64) CHARACTER SET ascii NOT NULL,
  alert_name VARCHAR(120) NOT NULL,
  criticality VARCHAR(16) NOT NULL CHECK (criticality IN ('informativa', 'preventiva', 'critica', 'urgente')),
  state VARCHAR(16) NOT NULL CHECK (state IN ('firing', 'resolved')),
  summary VARCHAR(500) NOT NULL,
  labels LONGTEXT NOT NULL CHECK (JSON_VALID(labels)),
  starts_at DATETIME(3) NOT NULL,
  resolved_at DATETIME(3) NULL,
  last_received_at DATETIME(3) NOT NULL,
  fire_count INT NOT NULL DEFAULT 1,
  ticket_id CHAR(36) CHARACTER SET ascii NULL,
  UNIQUE KEY health_external_alerts_fingerprint (project_id, source, fingerprint),
  KEY health_external_alerts_recent (project_id, state, last_received_at),
  CONSTRAINT health_external_alerts_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT health_external_alerts_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

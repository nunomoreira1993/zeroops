-- Monitorizacao de saude (alarmistica) por projeto: configuracao, estado atual de cada verificacao,
-- historico de amostras, alertas com rececao/atribuicao, notificacoes e amostras do agente do host.
-- Idempotente: pode ser executado mais do que uma vez.
CREATE TABLE IF NOT EXISTS health_settings (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  config LONGTEXT NOT NULL,
  agent_token_hash CHAR(64) CHARACTER SET ascii NULL,
  last_cycle_at DATETIME(3) NULL,
  last_report_at DATETIME(3) NULL,
  version INT NOT NULL DEFAULT 1,
  updated_by CHAR(36) CHARACTER SET ascii NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY health_settings_agent_token (agent_token_hash),
  CONSTRAINT health_settings_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS health_check_state (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  check_id VARCHAR(64) CHARACTER SET ascii NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('ok', 'warning', 'critical', 'unknown')),
  value DOUBLE NULL,
  unit VARCHAR(16) NULL,
  summary VARCHAR(500) NOT NULL,
  details LONGTEXT NULL,
  checked_at DATETIME(3) NOT NULL,
  status_since DATETIME(3) NOT NULL,
  PRIMARY KEY (project_id, check_id),
  CONSTRAINT health_check_state_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS health_samples (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  check_id VARCHAR(64) CHARACTER SET ascii NOT NULL,
  status VARCHAR(16) NOT NULL,
  value DOUBLE NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY health_samples_check (project_id, check_id, created_at),
  KEY health_samples_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- open_key = "projeto:verificacao" enquanto o alerta esta aberto e NULL depois de resolvido:
-- garante no maximo um alerta aberto por verificacao.
CREATE TABLE IF NOT EXISTS health_alerts (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  check_id VARCHAR(64) CHARACTER SET ascii NOT NULL,
  criticality VARCHAR(16) NOT NULL CHECK (criticality IN ('informativa', 'preventiva', 'critica', 'urgente')),
  severity VARCHAR(16) NOT NULL CHECK (severity IN ('warning', 'critical', 'unknown')),
  summary VARCHAR(500) NOT NULL,
  open_key VARCHAR(110) CHARACTER SET ascii NULL,
  opened_at DATETIME(3) NOT NULL,
  last_notified_at DATETIME(3) NULL,
  notify_count INT NOT NULL DEFAULT 0,
  acknowledged_at DATETIME(3) NULL,
  acknowledged_by CHAR(36) CHARACTER SET ascii NULL,
  assigned_to CHAR(36) CHARACTER SET ascii NULL,
  resolved_at DATETIME(3) NULL,
  UNIQUE KEY health_alerts_open (open_key),
  KEY health_alerts_project (project_id, opened_at),
  CONSTRAINT health_alerts_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT health_alerts_ack_fk FOREIGN KEY (acknowledged_by) REFERENCES users(id),
  CONSTRAINT health_alerts_assigned_fk FOREIGN KEY (assigned_to) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS health_notifications (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  alert_id CHAR(36) CHARACTER SET ascii NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('alert', 'resolved', 'report')),
  channel VARCHAR(16) NOT NULL CHECK (channel IN ('email', 'sms', 'chamada')),
  recipients TEXT NOT NULL,
  subject VARCHAR(300) NOT NULL,
  body LONGTEXT NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent', 'failed', 'blocked')),
  error_code VARCHAR(100) NULL,
  attempts INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sent_at DATETIME(3) NULL,
  KEY health_notifications_pending (state, created_at),
  KEY health_notifications_alert (alert_id),
  CONSTRAINT health_notifications_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS health_agent_samples (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  host VARCHAR(255) NOT NULL,
  payload LONGTEXT NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY health_agent_samples_project (project_id, received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

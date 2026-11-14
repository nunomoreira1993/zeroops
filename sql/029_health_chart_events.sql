-- Historico operacional independente de tickets; migracao aditiva/idempotente.
CREATE TABLE IF NOT EXISTS health_chart_outages (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  environment VARCHAR(16) NOT NULL CHECK (environment IN ('quality','production')),
  cause VARCHAR(16) NOT NULL CHECK (cause IN ('http','db2','maintenance')),
  resource VARCHAR(1000) NOT NULL,
  open_key CHAR(64) CHARACTER SET ascii NULL,
  started_at DATETIME(3) NOT NULL,
  confirmed_at DATETIME(3) NULL,
  recovered_at DATETIME(3) NULL,
  last_observed_at DATETIME(3) NOT NULL,
  planned TINYINT(1) NOT NULL DEFAULT 0,
  observation_gap TINYINT(1) NOT NULL DEFAULT 0,
  UNIQUE KEY health_chart_outages_open (open_key),
  KEY health_chart_outages_range (project_id,environment,started_at),
  CONSTRAINT health_chart_outages_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE health_notifications
  ADD COLUMN IF NOT EXISTS environment VARCHAR(16) NULL;
CREATE INDEX IF NOT EXISTS health_notifications_chart_range
  ON health_notifications(project_id,environment,sent_at);

-- Apenas alertas externos com ambiente historico explicito permitem backfill fiavel.
UPDATE health_notifications n
JOIN health_external_alerts a ON a.id=n.alert_id AND a.project_id=n.project_id
SET n.environment=JSON_UNQUOTE(JSON_EXTRACT(a.labels,'$.env'))
WHERE n.environment IS NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(a.labels,'$.env')) IN ('production','quality');

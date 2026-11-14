-- Um fluxo por tipo de alerta da Saude. O ticket gerado pela alarmistica guarda a chave do alerta
-- que o abriu (`prometheus:<alertname>` ou `check:<id da verificacao>`) e entra no fluxo associado
-- a essa chave; sem associacao, segue a selecao normal (fluxo de incidentes por omissao).
-- Idempotente; nao remove dados.

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS alert_key VARCHAR(160) CHARACTER SET ascii NULL;

CREATE TABLE IF NOT EXISTS health_alert_flows (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  alert_key VARCHAR(160) CHARACTER SET ascii NOT NULL,
  flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  updated_by CHAR(36) CHARACTER SET ascii NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (project_id, alert_key),
  KEY health_alert_flows_flow (flow_id),
  CONSTRAINT health_alert_flows_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  -- Apagar o fluxo remove a associacao: os alertas voltam ao fluxo por omissao.
  CONSTRAINT health_alert_flows_flow_fk FOREIGN KEY (flow_id, project_id)
    REFERENCES flows(id, project_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

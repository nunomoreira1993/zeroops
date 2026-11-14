-- Historico por alarme da pagina Saude: abertura, agravamento, lembretes, rececao, atribuicao,
-- resolucao e ticket, com o utilizador que agiu. Cobre os alertas internos (`internal`, tabela
-- health_alerts) e os do Prometheus (`prometheus`, tabela health_external_alerts). Idempotente.

CREATE TABLE IF NOT EXISTS health_alert_events (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  alert_id CHAR(36) CHARACTER SET ascii NOT NULL,
  source VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'internal'
    CHECK (source IN ('internal', 'prometheus')),
  kind VARCHAR(20) CHARACTER SET ascii NOT NULL
    CHECK (kind IN ('opened', 'escalated', 'reminder', 'acknowledged', 'assigned', 'unassigned', 'resolved', 'refired', 'ticket')),
  actor_id CHAR(36) CHARACTER SET ascii NULL,
  detail VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY health_alert_events_alert (project_id, alert_id, created_at),
  KEY health_alert_events_recent (project_id, created_at),
  CONSTRAINT health_alert_events_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT health_alert_events_actor_fk FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reconstroi o historico ja conhecido dos alertas existentes (so quando ainda nao tem eventos).
INSERT INTO health_alert_events (project_id, alert_id, source, kind, detail, created_at)
SELECT a.project_id, a.id, 'internal', 'opened', a.summary, a.opened_at FROM health_alerts a
WHERE NOT EXISTS (SELECT 1 FROM health_alert_events e WHERE e.alert_id = a.id);

INSERT INTO health_alert_events (project_id, alert_id, source, kind, actor_id, created_at)
SELECT a.project_id, a.id, 'internal', 'acknowledged', a.acknowledged_by, a.acknowledged_at FROM health_alerts a
WHERE a.acknowledged_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM health_alert_events e WHERE e.alert_id = a.id AND e.kind = 'acknowledged');

INSERT INTO health_alert_events (project_id, alert_id, source, kind, detail, created_at)
SELECT a.project_id, a.id, 'internal', 'assigned', u.display_name, a.opened_at FROM health_alerts a
JOIN users u ON u.id = a.assigned_to
WHERE NOT EXISTS (SELECT 1 FROM health_alert_events e WHERE e.alert_id = a.id AND e.kind = 'assigned');

INSERT INTO health_alert_events (project_id, alert_id, source, kind, created_at)
SELECT a.project_id, a.id, 'internal', 'resolved', a.resolved_at FROM health_alerts a
WHERE a.resolved_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM health_alert_events e WHERE e.alert_id = a.id AND e.kind = 'resolved');

INSERT INTO health_alert_events (project_id, alert_id, source, kind, detail, created_at)
SELECT x.project_id, x.id, 'prometheus', 'opened', x.summary, x.starts_at FROM health_external_alerts x
WHERE NOT EXISTS (SELECT 1 FROM health_alert_events e WHERE e.alert_id = x.id);

INSERT INTO health_alert_events (project_id, alert_id, source, kind, detail, created_at)
SELECT x.project_id, x.id, 'prometheus', 'ticket', x.ticket_id, x.starts_at FROM health_external_alerts x
WHERE x.ticket_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM health_alert_events e WHERE e.alert_id = x.id AND e.kind = 'ticket');

INSERT INTO health_alert_events (project_id, alert_id, source, kind, created_at)
SELECT x.project_id, x.id, 'prometheus', 'resolved', x.resolved_at FROM health_external_alerts x
WHERE x.state = 'resolved' AND x.resolved_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM health_alert_events e WHERE e.alert_id = x.id AND e.kind = 'resolved');

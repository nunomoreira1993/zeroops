-- Non-destructive support only. The purge itself is MANUAL (sql/manual/).
CREATE TABLE IF NOT EXISTS ticket_purge_health_occurrences (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  source VARCHAR(16) CHARACTER SET ascii NOT NULL,
  alert_id CHAR(36) CHARACTER SET ascii NOT NULL,
  occurrence_at DATETIME(3) NOT NULL,
  PRIMARY KEY (project_id, source, alert_id),
  CONSTRAINT ticket_purge_occurrences_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Expiring project-only ticket quiescence. Health collection and email queues remain enabled.
CREATE TABLE IF NOT EXISTS ticket_purge_maintenance (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  lease_id CHAR(36) CHARACTER SET ascii NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii NOT NULL,
  lease_until DATETIME(3) NOT NULL,
  runtime_fingerprint CHAR(64) CHARACTER SET ascii NOT NULL,
  CONSTRAINT ticket_purge_maintenance_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT ticket_purge_maintenance_actor_fk FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

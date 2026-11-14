-- Agregados horarios das metricas dos graficos da pagina Saude (media, maximo e p95 por hora e
-- servidor), calculados pelo worker a partir do Prometheus. Sustentam o intervalo de 13 meses e o
-- mapa de calor (dia da semana x hora). Retencao de 400 dias. Idempotente.

CREATE TABLE IF NOT EXISTS health_metric_hourly (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  environment VARCHAR(16) CHARACTER SET ascii NOT NULL
    CHECK (environment IN ('production', 'quality')),
  metric VARCHAR(40) CHARACTER SET ascii NOT NULL,
  instance VARCHAR(190) CHARACTER SET ascii NOT NULL,
  hour_start DATETIME NOT NULL,
  avg_value DOUBLE NULL,
  max_value DOUBLE NULL,
  p95_value DOUBLE NULL,
  PRIMARY KEY (project_id, environment, metric, instance, hour_start),
  KEY health_metric_hourly_recent (project_id, environment, hour_start),
  CONSTRAINT health_metric_hourly_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

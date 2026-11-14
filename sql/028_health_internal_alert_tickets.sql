-- Liga alertas internos da Saúde ao ticket de análise criado para o incidente.
ALTER TABLE health_alerts
  ADD COLUMN IF NOT EXISTS ticket_id CHAR(36) CHARACTER SET ascii NULL AFTER summary;

ALTER TABLE health_alerts DROP CONSTRAINT IF EXISTS health_alerts_ticket_fk;
ALTER TABLE health_alerts
  ADD CONSTRAINT health_alerts_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id);

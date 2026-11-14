-- Incidentes da Saude: varios alertas em cascata (ex.: MySQL em baixo e sites a falhar) ficam
-- num so ticket. Quando todos recuperam, o Copilot faz a analise pos-incidente e o ticket fecha
-- com um relatorio para a equipa e uma mensagem para o cliente. Idempotente.

CREATE TABLE IF NOT EXISTS health_incidents (
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  environment VARCHAR(20) NOT NULL CHECK (environment IN ('quality', 'production')),
  root_alert_id CHAR(36) CHARACTER SET ascii NOT NULL,
  root_title VARCHAR(160) NOT NULL,
  -- open: alertas ativos; recovered: tudo recuperou, a aguardar o fim de uma investigacao em curso;
  -- reviewing: analise pos-incidente do Copilot em curso; closed: relatorio final publicado.
  state VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'recovered', 'reviewing', 'closed')),
  review_run_id CHAR(36) CHARACTER SET ascii NULL,
  opened_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  recovered_at DATETIME(3) NULL,
  closed_at DATETIME(3) NULL,
  KEY health_incidents_open (project_id, environment, state, opened_at),
  CONSTRAINT health_incidents_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT health_incidents_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Origem do run: auto = investigacao automatica ao criar o ticket; incident_review = analise
-- pos-incidente da Saude. Em MariaDB o CHECK em linha so desaparece ao redefinir a coluna.
ALTER TABLE agent_runs MODIFY run_trigger VARCHAR(20) NOT NULL DEFAULT 'manual';
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_trigger_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_trigger_check
  CHECK (run_trigger IN ('manual', 'client_reply', 'auto', 'incident_review'));

-- Investigacao automatica do Copilot em cada ticket novo (ligada por omissao).
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS agent_auto_investigate TINYINT(1) NOT NULL DEFAULT 1;

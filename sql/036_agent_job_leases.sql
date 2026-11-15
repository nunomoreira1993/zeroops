-- P03: propriedade explicita das tentativas (worker, lease, heartbeat e epoca de posse crescente).
-- `lease_epoch` funciona como fencing token: cada claim/recuperacao incrementa-o e todas as
-- escritas do executor (progresso, conclusao, falha, eventos e chamadas a conectores) exigem a
-- epoca atual com lease valido. Substitui a falha global dos runs no arranque (`failInterrupted`).
-- Aditiva e idempotente (MariaDB 10.3: sem SKIP LOCKED; o claim usa FOR UPDATE + UPDATE condicional).

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS worker_id VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS lease_epoch INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_until DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS heartbeat_at DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS attempt INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tool_calls_used INT UNSIGNED NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS agent_runs_lease ON agent_runs (status, lease_until);

-- Runs ja iniciados contam como primeira tentativa; os em curso mantem o contador de chamadas.
UPDATE agent_runs SET attempt = 1 WHERE attempt = 0 AND started_at IS NOT NULL;
UPDATE agent_runs r
   SET r.tool_calls_used = (SELECT COUNT(*) FROM agent_run_tool_calls c WHERE c.run_id = r.id)
 WHERE r.status = 'running' AND r.tool_calls_used = 0;

ALTER TABLE flow_assistant_requests
  ADD COLUMN IF NOT EXISTS worker_id VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS lease_epoch INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_until DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS heartbeat_at DATETIME(3) NULL,
  ADD COLUMN IF NOT EXISTS attempt INT UNSIGNED NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS flow_assistant_lease ON flow_assistant_requests (status, lease_until);

UPDATE flow_assistant_requests SET attempt = 1 WHERE attempt = 0 AND started_at IS NOT NULL;

-- Epoca da tentativa que fez cada chamada a conectores (null nas chamadas anteriores a P03).
ALTER TABLE agent_run_tool_calls
  ADD COLUMN IF NOT EXISTS lease_epoch INT UNSIGNED NULL;

-- Eventos correlacionados do ciclo de vida das tentativas (claim, heartbeat perdido, recuperacao,
-- cancelamento, libertacao e rejeicao de tentativa antiga). Sem FK: sobrevive a falhas parciais e
-- e removido pela purga de tickets por `ticket_id`.
CREATE TABLE IF NOT EXISTS agent_job_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  job_kind VARCHAR(20) CHARACTER SET ascii NOT NULL
    CHECK (job_kind IN ('agent_run', 'flow_assistant')),
  job_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  ticket_id CHAR(36) CHARACTER SET ascii NULL,
  flow_step_id CHAR(36) CHARACTER SET ascii NULL,
  attempt INT UNSIGNED NOT NULL DEFAULT 0,
  lease_epoch INT UNSIGNED NOT NULL DEFAULT 0,
  worker_id VARCHAR(120) NULL,
  event_type VARCHAR(40) CHARACTER SET ascii NOT NULL,
  details LONGTEXT NULL CHECK (details IS NULL OR JSON_VALID(details)),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY agent_job_events_job (job_kind, job_id, id),
  KEY agent_job_events_ticket (ticket_id),
  KEY agent_job_events_project (project_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- P05: encaminhamento semantico com esclarecimentos.
-- `flows.routing_policy` e a politica do RASCUNHO (instrucoes, exemplos, fallback); a politica em
-- servico fica na versao ativa (`flow_versions.routing.policy`), por isso so muda com a ativacao.
-- `ticket_routing` fixa, na criacao do ticket, os candidatos (fluxo + versao + hash do manifesto)
-- e a versao da politica; classificacao, perguntas e retries usam sempre esse conjunto.
-- Aditiva e idempotente; tickets existentes nao sao reencaminhados.

ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS routing_policy LONGTEXT NULL
    CHECK (routing_policy IS NULL OR JSON_VALID(routing_policy));

CREATE TABLE IF NOT EXISTS ticket_routing (
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  status VARCHAR(20) CHARACTER SET ascii NOT NULL,
  policy_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  candidates LONGTEXT NOT NULL CHECK (JSON_VALID(candidates)),
  fallback LONGTEXT NULL CHECK (fallback IS NULL OR JSON_VALID(fallback)),
  start_context LONGTEXT NULL CHECK (start_context IS NULL OR JSON_VALID(start_context)),
  questions_asked INT UNSIGNED NOT NULL DEFAULT 0,
  failures INT UNSIGNED NOT NULL DEFAULT 0,
  job_seq INT UNSIGNED NOT NULL DEFAULT 0,
  question_id CHAR(36) CHARACTER SET ascii NULL,
  question_text TEXT NULL,
  question_at DATETIME(3) NULL,
  reply_due_at DATETIME(3) NULL,
  last_decision LONGTEXT NULL CHECK (last_decision IS NULL OR JSON_VALID(last_decision)),
  resolution VARCHAR(20) CHARACTER SET ascii NULL,
  reason VARCHAR(600) NULL,
  chosen_flow_id CHAR(36) CHARACTER SET ascii NULL,
  chosen_version_id CHAR(36) CHARACTER SET ascii NULL,
  routed_by CHAR(36) CHARACTER SET ascii NULL,
  routed_at DATETIME(3) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT ticket_routing_status_check
    CHECK (status IN ('classifying', 'awaiting_reply', 'pending_manual', 'routed', 'cancelled')),
  KEY ticket_routing_project (project_id, status),
  KEY ticket_routing_reply_due (status, reply_due_at),
  CONSTRAINT ticket_routing_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tentativas de classificacao (uma por ronda: criacao e cada resposta do autor). `seq` torna a
-- criacao idempotente; a posse segue o modelo de leases do P03.
CREATE TABLE IF NOT EXISTS ticket_routing_jobs (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  seq INT UNSIGNED NOT NULL,
  status VARCHAR(20) CHARACTER SET ascii NOT NULL,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  attempt INT UNSIGNED NOT NULL DEFAULT 0,
  worker_id VARCHAR(120) NULL,
  lease_epoch INT UNSIGNED NOT NULL DEFAULT 0,
  lease_until DATETIME(3) NULL,
  heartbeat_at DATETIME(3) NULL,
  reply LONGTEXT NULL CHECK (reply IS NULL OR JSON_VALID(reply)),
  error_code VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  CONSTRAINT ticket_routing_jobs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  UNIQUE KEY ticket_routing_jobs_seq (ticket_id, seq),
  KEY ticket_routing_jobs_queue (status, available_at),
  KEY ticket_routing_jobs_lease (status, lease_until),
  CONSTRAINT ticket_routing_jobs_routing_fk FOREIGN KEY (ticket_id) REFERENCES ticket_routing(ticket_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Resposta do autor a uma pergunta concreta (uma por pergunta: webhooks/mensagens repetidos
-- nao duplicam a retoma).
CREATE TABLE IF NOT EXISTS ticket_routing_replies (
  question_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  comment_id CHAR(36) CHARACTER SET ascii NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ticket_routing_replies_ticket (ticket_id),
  CONSTRAINT ticket_routing_replies_routing_fk FOREIGN KEY (ticket_id) REFERENCES ticket_routing(ticket_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Auditoria do encaminhamento (versoes consideradas, decisoes, perguntas, respostas, escolha).
CREATE TABLE IF NOT EXISTS ticket_routing_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  kind VARCHAR(40) CHARACTER SET ascii NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii NULL,
  job_id CHAR(36) CHARACTER SET ascii NULL,
  details LONGTEXT NULL CHECK (details IS NULL OR JSON_VALID(details)),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ticket_routing_events_ticket (ticket_id, id),
  CONSTRAINT ticket_routing_events_routing_fk FOREIGN KEY (ticket_id) REFERENCES ticket_routing(ticket_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Eventos de leases tambem para as tentativas de classificacao. Em MariaDB o CHECK em linha da
-- coluna so sai com MODIFY; depois passa a constraint com nome (como em 010/017/024).
ALTER TABLE agent_job_events MODIFY job_kind VARCHAR(20) CHARACTER SET ascii NOT NULL;
ALTER TABLE agent_job_events DROP CONSTRAINT IF EXISTS agent_job_events_kind_check;
ALTER TABLE agent_job_events ADD CONSTRAINT agent_job_events_kind_check
  CHECK (job_kind IN ('agent_run', 'flow_assistant', 'ticket_routing'));

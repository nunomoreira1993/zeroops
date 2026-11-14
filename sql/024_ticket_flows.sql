-- Fluxos de resolucao de tickets por projeto: definicao editavel (rascunho), versoes publicadas
-- imutaveis, execucao por ticket presa a versao publicada no momento da entrada, historico de
-- etapas/decisoes e pedidos ao assistente (Copilot). Idempotente.
-- Projetos sem fluxo configurado recebem automaticamente os modelos por omissao (codigo), que
-- reproduzem o comportamento anterior; nao ha dados a migrar aqui.

-- Origem do ticket (portal do cliente, equipa, Saude ou API) usada nas regras de selecao.
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS origin VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'portal_client';
ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_origin_check;
ALTER TABLE tickets ADD CONSTRAINT tickets_origin_check
  CHECK (origin IN ('portal_client', 'portal_team', 'health', 'api'));
UPDATE tickets t JOIN health_incidents h ON h.ticket_id = t.id
  SET t.origin = 'health' WHERE t.origin <> 'health';

CREATE TABLE IF NOT EXISTS flows (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  name VARCHAR(80) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  template VARCHAR(40) CHARACTER SET ascii NULL,
  -- Menor numero = maior precedencia entre regras coincidentes; unico por projeto.
  priority INT NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  flow_match LONGTEXT NOT NULL CHECK (JSON_VALID(flow_match)),
  flow_definition LONGTEXT NOT NULL CHECK (JSON_VALID(flow_definition)),
  draft_version INT NOT NULL DEFAULT 1,
  published_version_id CHAR(36) CHARACTER SET ascii NULL,
  created_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  default_project CHAR(36) CHARACTER SET ascii AS (IF(is_default = 1, project_id, NULL)) PERSISTENT,
  UNIQUE KEY flows_one_default (default_project),
  UNIQUE KEY flows_priority (project_id, priority),
  UNIQUE KEY flows_name (project_id, name),
  UNIQUE KEY flows_project_scope (id, project_id),
  CONSTRAINT flows_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_versions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  number INT NOT NULL,
  flow_definition LONGTEXT NOT NULL CHECK (JSON_VALID(flow_definition)),
  logic_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  published_by CHAR(36) CHARACTER SET ascii NULL,
  published_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY flow_versions_number (flow_id, number),
  CONSTRAINT flow_versions_flow_fk FOREIGN KEY (flow_id, project_id) REFERENCES flows(id, project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Uma execucao por ticket, presa a versao publicada quando o ticket entrou no fluxo.
CREATE TABLE IF NOT EXISTS flow_executions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  version_id CHAR(36) CHARACTER SET ascii NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'running'
    CHECK (status IN ('running', 'waiting', 'completed', 'failed', 'cancelled')),
  current_node VARCHAR(48) NULL,
  current_step_id CHAR(36) CHARACTER SET ascii NULL,
  -- Contexto de entrada (ex.: instrucoes do alerta da Saude para a primeira analise).
  execution_context LONGTEXT NULL CHECK (execution_context IS NULL OR JSON_VALID(execution_context)),
  -- Proxima verificacao pelo worker (etapas automaticas ou prazos de verificacao).
  wake_at DATETIME(3) NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  UNIQUE KEY flow_executions_ticket (ticket_id),
  KEY flow_executions_wake (status, wake_at),
  KEY flow_executions_version (version_id, status),
  CONSTRAINT flow_executions_ticket_fk FOREIGN KEY (ticket_id, project_id) REFERENCES tickets(id, project_id),
  CONSTRAINT flow_executions_version_fk FOREIGN KEY (version_id) REFERENCES flow_versions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_execution_steps (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  execution_id CHAR(36) CHARACTER SET ascii NOT NULL,
  node_id VARCHAR(48) NOT NULL,
  attempt INT NOT NULL,
  -- Ordem cronologica dentro da execucao (varias etapas podem comecar no mesmo milissegundo).
  step_sequence INT NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('active', 'waiting', 'completed', 'failed')),
  step_assignee LONGTEXT NULL CHECK (step_assignee IS NULL OR JSON_VALID(step_assignee)),
  step_input LONGTEXT NULL CHECK (step_input IS NULL OR JSON_VALID(step_input)),
  step_output LONGTEXT NULL CHECK (step_output IS NULL OR JSON_VALID(step_output)),
  port VARCHAR(32) NULL,
  actor_id CHAR(36) CHARACTER SET ascii NULL,
  agent_run_id CHAR(36) CHARACTER SET ascii NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  UNIQUE KEY flow_steps_attempt (execution_id, node_id, attempt),
  UNIQUE KEY flow_steps_sequence (execution_id, step_sequence),
  KEY flow_steps_run (agent_run_id),
  CONSTRAINT flow_steps_execution_fk FOREIGN KEY (execution_id) REFERENCES flow_executions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Uma decisao por etapa; a chave de idempotencia absorve duplo clique e reenvios.
CREATE TABLE IF NOT EXISTS flow_decisions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  step_id CHAR(36) CHARACTER SET ascii NOT NULL,
  idempotency_key VARCHAR(80) CHARACTER SET ascii NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii NOT NULL,
  port VARCHAR(32) NOT NULL,
  comment_body TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY flow_decisions_step (step_id),
  UNIQUE KEY flow_decisions_key (idempotency_key),
  CONSTRAINT flow_decisions_step_fk FOREIGN KEY (step_id) REFERENCES flow_execution_steps(id),
  CONSTRAINT flow_decisions_actor_fk FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_execution_events (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  execution_id CHAR(36) CHARACTER SET ascii NOT NULL,
  step_id CHAR(36) CHARACTER SET ascii NULL,
  kind VARCHAR(40) CHARACTER SET ascii NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii NULL,
  event_details LONGTEXT NULL CHECK (event_details IS NULL OR JSON_VALID(event_details)),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY flow_events_execution (execution_id, created_at),
  CONSTRAINT flow_events_execution_fk FOREIGN KEY (execution_id) REFERENCES flow_executions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pedidos ao assistente: alterar um fluxo (scope=flow) ou ajudar num ticket (scope=ticket).
CREATE TABLE IF NOT EXISTS flow_assistant_requests (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  scope VARCHAR(10) NOT NULL CHECK (scope IN ('flow', 'ticket')),
  flow_id CHAR(36) CHARACTER SET ascii NULL,
  ticket_id CHAR(36) CHARACTER SET ascii NULL,
  requested_by CHAR(36) CHARACTER SET ascii NOT NULL,
  message TEXT NOT NULL,
  assistant_context LONGTEXT NULL CHECK (assistant_context IS NULL OR JSON_VALID(assistant_context)),
  base_draft_version INT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  assistant_response LONGTEXT NULL CHECK (assistant_response IS NULL OR JSON_VALID(assistant_response)),
  resolution VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (resolution IN ('pending', 'accepted', 'discarded')),
  error_code VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  KEY flow_assistant_queue (status, created_at),
  KEY flow_assistant_flow (flow_id, created_at),
  KEY flow_assistant_ticket (ticket_id, created_at),
  CONSTRAINT flow_assistant_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT flow_assistant_requester_fk FOREIGN KEY (requested_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Runs do Copilot pedidos por uma etapa do fluxo: trigger 'flow', modo 'implement' (proposta de
-- alteracao em diff) e ligacao a etapa. O CHECK em linha de mode so desaparece ao redefinir a coluna.
ALTER TABLE agent_runs MODIFY mode VARCHAR(20) NOT NULL DEFAULT 'investigate';
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_mode_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_mode_check
  CHECK (mode IN ('investigate', 'implement'));
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_trigger_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_trigger_check
  CHECK (run_trigger IN ('manual', 'client_reply', 'auto', 'incident_review', 'flow'));
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS flow_step_id CHAR(36) CHARACTER SET ascii NULL,
  -- Relatorios e desenvolvimento pedidos pelo fluxo nunca enviam perguntas ao cliente.
  ADD COLUMN IF NOT EXISTS client_questions_allowed TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS patch LONGTEXT NULL,
  ADD COLUMN IF NOT EXISTS proposed_tests LONGTEXT NULL CHECK (proposed_tests IS NULL OR JSON_VALID(proposed_tests));

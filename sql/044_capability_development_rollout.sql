-- P10: desenvolvimento de capacidades e rollout do ZeroOps.
-- `project_capability_settings`: recursos explicitamente atribuidos ao projeto para desenvolver
-- capacidades (repositorio do ZeroOps, pipeline/alvo de publicacao e fluxo de desenvolvimento).
-- `capability_developments`: um processo por pedido de capacidade em falta (P06), com categoria,
-- requisito, criterios de aceitacao, revisao/hash do rascunho de origem, ticket do desenvolvimento,
-- autorizacao de publicacao (separada do desenvolvimento), versao publicada (commit/artefacto),
-- confirmacao no runtime e associacao auditada ao rascunho. Nunca ativa o fluxo.
-- `capability_development_events`: historico auditavel do processo.
-- `zeroops_runtime_drains`: pedidos de drenagem do rollout (os executores deixam de reclamar jobs
-- novos enquanto houver uma linha ativa; expira sozinha se o operador morrer).
-- `zeroops_active_jobs`: jobs com lease vivo (o deploy espera por zero antes de trocar processos).
-- Aditiva e idempotente; o CHECK legado de `flow_capability_requests` nao muda.

CREATE TABLE IF NOT EXISTS project_capability_settings (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  repository_id CHAR(36) CHARACTER SET ascii NOT NULL,
  pipeline_id CHAR(36) CHARACTER SET ascii NOT NULL,
  development_flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT project_capability_settings_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT project_capability_settings_repository_fk FOREIGN KEY (repository_id) REFERENCES project_git_repositories(id),
  CONSTRAINT project_capability_settings_pipeline_fk FOREIGN KEY (pipeline_id) REFERENCES project_pipelines(id),
  CONSTRAINT project_capability_settings_flow_fk FOREIGN KEY (development_flow_id) REFERENCES flows(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS capability_developments (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  capability_request_id CHAR(36) CHARACTER SET ascii NOT NULL,
  category VARCHAR(20) CHARACTER SET ascii NOT NULL,
  title VARCHAR(180) NOT NULL,
  requirement TEXT NOT NULL,
  acceptance_criteria LONGTEXT NOT NULL CHECK (JSON_VALID(acceptance_criteria)),
  required TINYINT(1) NOT NULL DEFAULT 1,
  source_draft_version INT UNSIGNED NOT NULL,
  source_draft_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  ticket_id CHAR(36) CHARACTER SET ascii NULL,
  -- NULL nas categorias sem codigo (configuracao/agente) quando o projeto nao tem recursos atribuidos.
  repository_id CHAR(36) CHARACTER SET ascii NULL,
  pipeline_id CHAR(36) CHARACTER SET ascii NULL,
  development_flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  state VARCHAR(30) CHARACTER SET ascii NOT NULL DEFAULT 'requested',
  state_reason VARCHAR(1000) NULL,
  requested_by CHAR(36) CHARACTER SET ascii NOT NULL,
  publish_authorized_by CHAR(36) CHARACTER SET ascii NULL,
  publish_authorized_at DATETIME(3) NULL,
  delivery_id CHAR(36) CHARACTER SET ascii NULL,
  published_sha CHAR(40) CHARACTER SET ascii NULL,
  published_digest CHAR(71) CHARACTER SET ascii NULL,
  runtime_version VARCHAR(80) NULL,
  runtime_confirmed_at DATETIME(3) NULL,
  linked_draft_version INT UNSIGNED NULL,
  linked_by CHAR(36) CHARACTER SET ascii NULL,
  linked_at DATETIME(3) NULL,
  cancelled_by CHAR(36) CHARACTER SET ascii NULL,
  cancelled_at DATETIME(3) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT capability_developments_category_check
    CHECK (category IN ('configuration', 'agent_skill', 'integration', 'zeroops_change')),
  CONSTRAINT capability_developments_state_check
    CHECK (state IN ('requested', 'developing', 'review', 'publishing', 'published', 'available',
      'linked', 'cancelled', 'failed', 'reconciliation_required')),
  UNIQUE KEY capability_developments_request (capability_request_id),
  UNIQUE KEY capability_developments_ticket (ticket_id),
  KEY capability_developments_flow (flow_id, state),
  KEY capability_developments_project (project_id, created_at),
  CONSTRAINT capability_developments_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT capability_developments_flow_fk FOREIGN KEY (flow_id) REFERENCES flows(id),
  CONSTRAINT capability_developments_request_fk FOREIGN KEY (capability_request_id) REFERENCES flow_capability_requests(id),
  CONSTRAINT capability_developments_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS capability_development_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  development_id CHAR(36) CHARACTER SET ascii NOT NULL,
  kind VARCHAR(40) CHARACTER SET ascii NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii NULL,
  payload LONGTEXT NOT NULL CHECK (JSON_VALID(payload)),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY capability_development_events_development (development_id, id),
  CONSTRAINT capability_development_events_development_fk FOREIGN KEY (development_id) REFERENCES capability_developments(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS zeroops_runtime_drains (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  reason VARCHAR(200) NOT NULL,
  requested_by VARCHAR(120) NOT NULL,
  correlation VARCHAR(200) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  released_at DATETIME(3) NULL,
  KEY zeroops_runtime_drains_active (released_at, expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE OR REPLACE VIEW zeroops_active_jobs AS
  SELECT 'agent_run' AS job_kind, id AS job_id, worker_id, lease_until FROM agent_runs
   WHERE status = 'running' AND lease_until > NOW(3)
  UNION ALL
  SELECT 'flow_assistant', id, worker_id, lease_until FROM flow_assistant_requests
   WHERE status = 'running' AND lease_until > NOW(3)
  UNION ALL
  SELECT 'ticket_routing', id, worker_id, lease_until FROM ticket_routing_jobs
   WHERE status = 'running' AND lease_until > NOW(3)
  UNION ALL
  SELECT 'flow_simulation', id, worker_id, lease_until FROM flow_simulation_runs
   WHERE status = 'running' AND lease_until > NOW(3)
  UNION ALL
  SELECT 'delivery', id, worker_id, lease_until FROM delivery_runs
   WHERE worker_id IS NOT NULL AND lease_until > NOW(3);
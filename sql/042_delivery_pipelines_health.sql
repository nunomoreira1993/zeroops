-- P09: pipeline, integracao e Health pelo fluxo.
-- `project_pipelines`: pipeline de entrega por projeto (fornecedor `webhook` assinado por HMAC),
-- repositorio/branch de destino, ambiente e politica explicita de integracao na branch. O segredo
-- fica cifrado (IdentityCipher) e nunca e devolvido pela API.
-- `delivery_runs`: uma entrega por etapa do fluxo, com o candidato revisto (head/base/ambito), a
-- combinacao integrada (topo da branch, SHA integrado, digest do artefacto), o estado da pipeline
-- externa (id, chave de idempotencia, checks, sequencia aplicada) e a posse (lease/epoca) do
-- executor que a processa. Estados terminais nunca regridem.
-- `delivery_events`: callbacks e reconciliacoes recebidas, unicas por pipeline/evento (duplicados
-- e mensagens fora de ordem ficam registados sem efeito).
-- `resource_locks`: locks duraveis por recurso real (branch de destino, ambiente da pipeline,
-- recurso Health), partilhados entre projetos, com detentor, epoca e expiracao.
-- `incident_interventions`: estado `uncertain` (resultado do relay desconhecido: reconciliar, nunca
-- repetir), chave do recurso e versao do contrato da acao.
-- Aditiva e idempotente.

CREATE TABLE IF NOT EXISTS project_pipelines (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  name VARCHAR(80) NOT NULL,
  provider VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'webhook',
  repository_id CHAR(36) CHARACTER SET ascii NOT NULL,
  target_branch VARCHAR(120) NOT NULL,
  environment VARCHAR(20) NOT NULL,
  endpoint_url VARCHAR(500) NOT NULL,
  secret_ciphertext TEXT NOT NULL,
  allow_integration TINYINT(1) NOT NULL DEFAULT 0,
  hold_policy VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'until_published',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  archived TINYINT(1) NOT NULL DEFAULT 0,
  created_by CHAR(36) CHARACTER SET ascii NULL,
  updated_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT project_pipelines_provider_check CHECK (provider IN ('webhook')),
  CONSTRAINT project_pipelines_environment_check CHECK (environment IN ('quality', 'production')),
  CONSTRAINT project_pipelines_hold_check CHECK (hold_policy IN ('until_published', 'until_flow_end')),
  UNIQUE KEY project_pipelines_name (project_id, name),
  CONSTRAINT project_pipelines_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT project_pipelines_repository_fk FOREIGN KEY (repository_id) REFERENCES project_git_repositories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS delivery_runs (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  execution_id CHAR(36) CHARACTER SET ascii NOT NULL,
  step_id CHAR(36) CHARACTER SET ascii NOT NULL,
  node_id VARCHAR(64) NOT NULL,
  pipeline_id CHAR(36) CHARACTER SET ascii NOT NULL,
  repository_id CHAR(36) CHARACTER SET ascii NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii NOT NULL,
  review_step_id CHAR(36) CHARACTER SET ascii NULL,
  environment VARCHAR(20) NOT NULL,
  target_branch VARCHAR(120) NOT NULL,
  candidate_base_sha CHAR(40) CHARACTER SET ascii NOT NULL,
  candidate_head_sha CHAR(40) CHARACTER SET ascii NOT NULL,
  candidate_scope_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  approvals LONGTEXT NULL CHECK (approvals IS NULL OR JSON_VALID(approvals)),
  target_sha CHAR(40) CHARACTER SET ascii NULL,
  integrated_sha CHAR(40) CHARACTER SET ascii NULL,
  revalidated TINYINT(1) NOT NULL DEFAULT 0,
  artifact_digest CHAR(71) CHARACTER SET ascii NULL,
  state VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'queued',
  state_reason VARCHAR(1000) NULL,
  idempotency_key CHAR(36) CHARACTER SET ascii NOT NULL,
  external_id VARCHAR(200) NULL,
  external_url VARCHAR(500) NULL,
  pipeline_status VARCHAR(20) CHARACTER SET ascii NULL,
  last_sequence INT UNSIGNED NOT NULL DEFAULT 0,
  checks LONGTEXT NULL CHECK (checks IS NULL OR JSON_VALID(checks)),
  evidence LONGTEXT NULL CHECK (evidence IS NULL OR JSON_VALID(evidence)),
  worker_id VARCHAR(120) NULL,
  lease_epoch INT UNSIGNED NOT NULL DEFAULT 0,
  lease_until DATETIME(3) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  next_check_at DATETIME(3) NULL,
  cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  CONSTRAINT delivery_runs_state_check CHECK (state IN ('queued', 'integrating', 'starting',
    'publishing', 'uncertain', 'published', 'failed', 'conflict', 'rework', 'blocked', 'cancelled')),
  UNIQUE KEY delivery_runs_step (step_id),
  UNIQUE KEY delivery_runs_idempotency (idempotency_key),
  KEY delivery_runs_queue (state, created_at),
  KEY delivery_runs_ticket (ticket_id, created_at),
  KEY delivery_runs_pipeline (pipeline_id, state),
  CONSTRAINT delivery_runs_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT delivery_runs_pipeline_fk FOREIGN KEY (pipeline_id) REFERENCES project_pipelines(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS delivery_events (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  delivery_id CHAR(36) CHARACTER SET ascii NOT NULL,
  pipeline_id CHAR(36) CHARACTER SET ascii NOT NULL,
  event_id VARCHAR(120) NOT NULL,
  source VARCHAR(20) CHARACTER SET ascii NOT NULL,
  sequence INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(20) CHARACTER SET ascii NOT NULL,
  outcome VARCHAR(20) CHARACTER SET ascii NOT NULL,
  payload LONGTEXT NULL CHECK (payload IS NULL OR JSON_VALID(payload)),
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY delivery_events_event (pipeline_id, event_id),
  KEY delivery_events_delivery (delivery_id, received_at),
  CONSTRAINT delivery_events_delivery_fk FOREIGN KEY (delivery_id) REFERENCES delivery_runs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS resource_locks (
  lock_key VARCHAR(300) NOT NULL PRIMARY KEY,
  holder_kind VARCHAR(20) CHARACTER SET ascii NOT NULL,
  holder_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NULL,
  epoch INT UNSIGNED NOT NULL DEFAULT 1,
  acquired_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  KEY resource_locks_holder (holder_kind, holder_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE incident_interventions ADD COLUMN IF NOT EXISTS resource_key VARCHAR(300) NULL;
ALTER TABLE incident_interventions ADD COLUMN IF NOT EXISTS contract_version VARCHAR(40) CHARACTER SET ascii NULL;
-- O CHECK em linha de `status` so desaparece ao redefinir a coluna (ver 010).
ALTER TABLE incident_interventions MODIFY status VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'pending';
ALTER TABLE incident_interventions DROP CONSTRAINT IF EXISTS incident_interventions_status_check;
ALTER TABLE incident_interventions ADD CONSTRAINT incident_interventions_status_check
  CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'refused', 'cancelled', 'simulated', 'uncertain'));

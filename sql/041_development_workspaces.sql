-- P08: workspace Git, desenvolvimento e review dinamico.
-- `project_git_repositories`: repositorios de desenvolvimento por projeto (URL sem credenciais,
-- branch base, referencias autorizadas, comandos de preparacao/teste e fornecedor de PR). A
-- credencial fica cifrada (IdentityCipher) e nunca e devolvida pela API.
-- `development_workspaces`: um workspace persistente por ticket/etapa/repositorio, com branch
-- propria `zeroops/...`, commit base fixo, head atual e posse (run + epoca do lease). So a
-- tentativa dona avanca o head (CAS sobre o head anterior).
-- `development_revisions`/`development_test_runs`: cada head produzido, o diff completo obtido do
-- Git e os comandos de teste efetivamente executados (exit code, log e SHA testado).
-- `development_publications`: branch e PR publicados, idempotentes por workspace/tipo, com estado
-- `uncertain` para reconciliar o remoto antes de repetir.
-- `development_review_decisions`: decisoes de review ligadas ao head e ao ambito exatos; um novo
-- head invalida as decisoes anteriores (sem as apagar).
-- Aditiva e idempotente. Sem FK para agent_runs/flow_execution_steps (ordem da purga de tickets).

CREATE TABLE IF NOT EXISTS project_git_repositories (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  name VARCHAR(80) NOT NULL,
  url VARCHAR(500) NOT NULL,
  base_branch VARCHAR(120) NOT NULL,
  allowed_refs LONGTEXT NOT NULL CHECK (JSON_VALID(allowed_refs)),
  setup_commands LONGTEXT NOT NULL CHECK (JSON_VALID(setup_commands)),
  test_commands LONGTEXT NOT NULL CHECK (JSON_VALID(test_commands)),
  pr_provider VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'zeroops',
  credential_ciphertext TEXT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  archived TINYINT(1) NOT NULL DEFAULT 0,
  verified_at DATETIME(3) NULL,
  verified_base_sha CHAR(40) CHARACTER SET ascii NULL,
  verification_error VARCHAR(500) NULL,
  created_by CHAR(36) CHARACTER SET ascii NULL,
  updated_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT project_git_repositories_provider_check CHECK (pr_provider IN ('zeroops', 'github')),
  UNIQUE KEY project_git_repositories_name (project_id, name),
  CONSTRAINT project_git_repositories_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS development_workspaces (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  repository_id CHAR(36) CHARACTER SET ascii NOT NULL,
  node_id VARCHAR(64) NOT NULL,
  execution_id CHAR(36) CHARACTER SET ascii NULL,
  branch VARCHAR(200) NOT NULL,
  base_branch VARCHAR(120) NOT NULL,
  base_sha CHAR(40) CHARACTER SET ascii NULL,
  head_sha CHAR(40) CHARACTER SET ascii NULL,
  publish_mode VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'none',
  state VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'pending',
  owner_run_id CHAR(36) CHARACTER SET ascii NULL,
  owner_epoch INT UNSIGNED NULL,
  diff LONGTEXT NULL,
  diff_sha256 CHAR(64) CHARACTER SET ascii NULL,
  diff_truncated TINYINT(1) NOT NULL DEFAULT 0,
  files LONGTEXT NULL CHECK (files IS NULL OR JSON_VALID(files)),
  tests_passed TINYINT(1) NOT NULL DEFAULT 0,
  retention_until DATETIME(3) NULL,
  cleaned_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT development_workspaces_state_check CHECK (state IN ('pending', 'active', 'idle', 'failed', 'cleaned')),
  CONSTRAINT development_workspaces_publish_check CHECK (publish_mode IN ('none', 'branch', 'pull_request')),
  UNIQUE KEY development_workspaces_step (ticket_id, node_id, repository_id),
  UNIQUE KEY development_workspaces_branch (repository_id, branch),
  KEY development_workspaces_cleanup (state, retention_until),
  CONSTRAINT development_workspaces_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT development_workspaces_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT development_workspaces_repository_fk FOREIGN KEY (repository_id) REFERENCES project_git_repositories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS development_revisions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii NOT NULL,
  agent_run_id CHAR(36) CHARACTER SET ascii NULL,
  run_epoch INT UNSIGNED NULL,
  base_sha CHAR(40) CHARACTER SET ascii NOT NULL,
  parent_sha CHAR(40) CHARACTER SET ascii NULL,
  head_sha CHAR(40) CHARACTER SET ascii NOT NULL,
  diff_sha256 CHAR(64) CHARACTER SET ascii NOT NULL,
  scope_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  files LONGTEXT NOT NULL CHECK (JSON_VALID(files)),
  tests_passed TINYINT(1) NOT NULL DEFAULT 0,
  manifest LONGTEXT NULL CHECK (manifest IS NULL OR JSON_VALID(manifest)),
  candidate_hash CHAR(64) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY development_revisions_head (workspace_id, head_sha),
  KEY development_revisions_ticket (ticket_id, created_at),
  CONSTRAINT development_revisions_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT development_revisions_workspace_fk FOREIGN KEY (workspace_id) REFERENCES development_workspaces(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS development_test_runs (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii NOT NULL,
  agent_run_id CHAR(36) CHARACTER SET ascii NULL,
  run_epoch INT UNSIGNED NULL,
  phase VARCHAR(10) CHARACTER SET ascii NOT NULL,
  name VARCHAR(60) NOT NULL,
  command VARCHAR(500) NOT NULL,
  exit_code INT NULL,
  timed_out TINYINT(1) NOT NULL DEFAULT 0,
  tested_sha CHAR(40) CHARACTER SET ascii NULL,
  working_tree_hash CHAR(64) CHARACTER SET ascii NULL,
  log MEDIUMTEXT NOT NULL,
  log_sha256 CHAR(64) CHARACTER SET ascii NOT NULL,
  duration_ms INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT development_test_runs_phase_check CHECK (phase IN ('agent', 'final')),
  KEY development_test_runs_workspace (workspace_id, created_at),
  CONSTRAINT development_test_runs_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT development_test_runs_workspace_fk FOREIGN KEY (workspace_id) REFERENCES development_workspaces(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS development_publications (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii NOT NULL,
  kind VARCHAR(20) CHARACTER SET ascii NOT NULL,
  provider VARCHAR(20) CHARACTER SET ascii NOT NULL,
  idempotency_key VARCHAR(120) CHARACTER SET ascii NOT NULL,
  state VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'pending',
  remote_ref VARCHAR(200) NULL,
  head_sha CHAR(40) CHARACTER SET ascii NULL,
  number INT UNSIGNED NULL,
  url VARCHAR(500) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  last_error VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT development_publications_kind_check CHECK (kind IN ('branch', 'pull_request')),
  CONSTRAINT development_publications_provider_check CHECK (provider IN ('git', 'zeroops', 'github')),
  CONSTRAINT development_publications_state_check CHECK (state IN ('pending', 'published', 'uncertain', 'conflict', 'failed')),
  UNIQUE KEY development_publications_key (idempotency_key),
  KEY development_publications_number (project_id, provider, kind, number),
  CONSTRAINT development_publications_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT development_publications_workspace_fk FOREIGN KEY (workspace_id) REFERENCES development_workspaces(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS development_review_decisions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  step_id CHAR(36) CHARACTER SET ascii NOT NULL,
  workspace_id CHAR(36) CHARACTER SET ascii NOT NULL,
  head_sha CHAR(40) CHARACTER SET ascii NOT NULL,
  scope_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii NOT NULL,
  port VARCHAR(64) NOT NULL,
  comment_body TEXT NULL,
  idempotency_key VARCHAR(80) CHARACTER SET ascii NOT NULL,
  override_used TINYINT(1) NOT NULL DEFAULT 0,
  invalidated_at DATETIME(3) NULL,
  invalidation_reason VARCHAR(40) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY development_review_decisions_key (idempotency_key),
  KEY development_review_decisions_step (step_id, actor_id, invalidated_at),
  KEY development_review_decisions_workspace (workspace_id, invalidated_at),
  CONSTRAINT development_review_decisions_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT development_review_decisions_workspace_fk FOREIGN KEY (workspace_id) REFERENCES development_workspaces(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS development_workspace_id CHAR(36) CHARACTER SET ascii NULL;

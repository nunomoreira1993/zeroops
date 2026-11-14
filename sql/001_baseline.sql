-- ZeroOps baseline MySQL/MariaDB (>= MariaDB 10.3 / MySQL 5.7).
-- Equivale ao estado final das antigas migrações PostgreSQL 001..013.
-- Idempotente: pode ser reaplicada numa base vazia ou já criada por esta baseline.
-- Convenções: UUID em CHAR(36) ascii, datas DATETIME(3) em UTC, JSON validado por CHECK.

-- Locks transacionais nomeados (ver lockInTransaction).
CREATE TABLE IF NOT EXISTS zeroops_locks (
  name VARCHAR(190) NOT NULL PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS projects (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  archived TINYINT(1) NOT NULL DEFAULT 0,
  version INT NOT NULL DEFAULT 0 CHECK (version >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO projects (id, name) VALUES ('00000000-0000-4000-8000-000000000001', 'Pizza Hut');

CREATE TABLE IF NOT EXISTS identity_organizations (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  code VARCHAR(20) NOT NULL CHECK (code IN ('client', 'deloitte')),
  name VARCHAR(200) NOT NULL,
  PRIMARY KEY (project_id, code),
  CONSTRAINT identity_organizations_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO identity_organizations (project_id, code, name)
SELECT id, 'client', 'Cliente' FROM projects;
INSERT IGNORE INTO identity_organizations (project_id, code, name)
SELECT id, 'deloitte', 'Deloitte' FROM projects;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  email VARCHAR(320) NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('client', 'technical', 'qa', 'release', 'admin')),
  password_hash VARCHAR(500) NOT NULL,
  disabled TINYINT(1) NOT NULL DEFAULT 0,
  organization VARCHAR(20) NULL,
  locale VARCHAR(10) NOT NULL DEFAULT 'pt-PT' CHECK (locale IN ('pt-PT', 'en')),
  password_failures INT NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  mfa_secret VARCHAR(500) NULL,
  mfa_last_step BIGINT NULL,
  instance_admin TINYINT(1) NOT NULL DEFAULT 0,
  mfa_enrollment_required TINYINT(1) NOT NULL DEFAULT 0,
  -- A collation é case-insensitive: equivale ao antigo índice único em lower(email).
  UNIQUE KEY users_email_unique (email),
  KEY users_project_idx (project_id),
  CONSTRAINT users_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT users_identity_organization_fk FOREIGN KEY (project_id, organization)
    REFERENCES identity_organizations(project_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS project_memberships (
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('client', 'technical', 'qa', 'release', 'admin')),
  organization VARCHAR(20) NULL CHECK (organization IN ('client', 'deloitte')),
  disabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, project_id),
  KEY project_memberships_project (project_id, user_id),
  CONSTRAINT project_memberships_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT project_memberships_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT project_memberships_org_fk FOREIGN KEY (project_id, organization)
    REFERENCES identity_organizations(project_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_sessions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  token_hash VARCHAR(128) CHARACTER SET ascii NOT NULL,
  csrf_hash VARCHAR(128) CHARACTER SET ascii NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  mfa_verified TINYINT(1) NOT NULL DEFAULT 0,
  verified_at DATETIME(3) NULL,
  project_id CHAR(36) CHARACTER SET ascii NULL,
  UNIQUE KEY identity_sessions_token_unique (token_hash),
  KEY identity_sessions_user_idx (user_id),
  KEY identity_sessions_expiry_idx (expires_at),
  CONSTRAINT identity_sessions_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT identity_sessions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_invites (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  email VARCHAR(320) NOT NULL,
  display_name VARCHAR(200) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('client', 'technical', 'qa', 'release', 'admin')),
  token_hash VARCHAR(128) CHARACTER SET ascii NOT NULL,
  created_by CHAR(36) CHARACTER SET ascii NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  organization VARCHAR(20) NULL CHECK (organization IN ('client', 'deloitte')),
  locale VARCHAR(10) NOT NULL DEFAULT 'pt-PT' CHECK (locale IN ('pt-PT', 'en')),
  -- Só um convite pendente por email/projeto (índice parcial em PostgreSQL).
  pending_email VARCHAR(320) AS (IF(used_at IS NULL AND revoked_at IS NULL, email, NULL)) PERSISTENT,
  UNIQUE KEY identity_invites_token_unique (token_hash),
  UNIQUE KEY identity_invites_pending_email_idx (project_id, pending_email),
  CONSTRAINT identity_invites_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT identity_invites_creator_fk FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_password_resets (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  token_hash VARCHAR(128) CHARACTER SET ascii NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  pending_user CHAR(36) CHARACTER SET ascii AS (IF(used_at IS NULL AND revoked_at IS NULL, user_id, NULL)) PERSISTENT,
  UNIQUE KEY identity_password_resets_token_unique (token_hash),
  UNIQUE KEY identity_password_resets_pending_user_idx (pending_user),
  CONSTRAINT identity_password_resets_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_challenges (
  token_hash VARCHAR(128) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  stage VARCHAR(20) NOT NULL CHECK (stage IN ('mfa', 'enrollment')),
  pending_secret VARCHAR(500) NULL,
  failures INT NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3) + INTERVAL 5 MINUTE),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY identity_challenges_expiry (expires_at),
  CONSTRAINT identity_challenges_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_recovery_codes (
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  code_hash VARCHAR(128) CHARACTER SET ascii NOT NULL,
  used_at DATETIME(3) NULL,
  PRIMARY KEY (user_id, code_hash),
  CONSTRAINT identity_recovery_codes_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_email_changes (
  token_hash VARCHAR(128) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  requested_by CHAR(36) CHARACTER SET ascii NOT NULL,
  email VARCHAR(320) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  CONSTRAINT identity_email_changes_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT identity_email_changes_requester_fk FOREIGN KEY (requested_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_mfa_resets (
  token_hash VARCHAR(128) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  requested_by CHAR(36) CHARACTER SET ascii NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  CONSTRAINT identity_mfa_resets_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT identity_mfa_resets_requester_fk FOREIGN KEY (requested_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_confirmations (
  token_hash VARCHAR(128) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  session_hash VARCHAR(128) CHARACTER SET ascii NOT NULL,
  action VARCHAR(100) NOT NULL,
  target VARCHAR(400) NOT NULL,
  expires_at DATETIME(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP(3) + INTERVAL 5 MINUTE),
  project_id CHAR(36) CHARACTER SET ascii NULL,
  CONSTRAINT identity_confirmations_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT identity_confirmations_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS identity_request_limits (
  key_hash VARCHAR(128) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  count INT NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  KEY identity_request_limits_expiry (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fila privada de entrega de identidade; nunca expor payload_ciphertext em APIs genéricas.
CREATE TABLE IF NOT EXISTS identity_mail (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  user_id CHAR(36) CHARACTER SET ascii NULL,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('invite', 'reset', 'email-change', 'lock', 'mfa-reset')),
  token_hash VARCHAR(128) CHARACTER SET ascii NULL,
  expires_at DATETIME(3) NOT NULL,
  key_version INT NOT NULL DEFAULT 1 CHECK (key_version = 1),
  payload_ciphertext MEDIUMTEXT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'processing', 'delivered', 'failed', 'blocked', 'uncertain')),
  attempts INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_id CHAR(36) CHARACTER SET ascii NULL,
  lease_until DATETIME(3) NULL,
  error_code VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  delivered_at DATETIME(3) NULL,
  CONSTRAINT identity_mail_lease_check
    CHECK ((state = 'processing') = (lease_id IS NOT NULL AND lease_until IS NOT NULL)),
  KEY identity_mail_claim_idx (state, created_at),
  KEY identity_mail_user_idx (user_id, created_at),
  KEY identity_mail_expiry_idx (expires_at),
  KEY identity_mail_token_idx (token_hash),
  CONSTRAINT identity_mail_user_fk FOREIGN KEY (user_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_key_counter (
  id TINYINT NOT NULL PRIMARY KEY,
  value BIGINT NOT NULL
) ENGINE=InnoDB;
INSERT IGNORE INTO ticket_key_counter (id, value) VALUES (1, 0);

CREATE TABLE IF NOT EXISTS tickets (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  `key` VARCHAR(32) NOT NULL DEFAULT '',
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  created_by CHAR(36) CHARACTER SET ascii NOT NULL,
  title VARCHAR(180) NOT NULL CHECK (CHAR_LENGTH(title) BETWEEN 5 AND 180),
  description TEXT NOT NULL CHECK (CHAR_LENGTH(description) BETWEEN 10 AND 20000),
  category VARCHAR(20) NOT NULL CHECK (category IN ('incident', 'bug', 'improvement', 'question')),
  environment VARCHAR(20) NOT NULL CHECK (environment IN ('development', 'quality', 'production')),
  priority VARCHAR(20) NOT NULL CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  status VARCHAR(30) NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'investigating', 'awaiting_information', 'awaiting_client', 'awaiting_confirmation',
    'awaiting_technical', 'implementing', 'awaiting_qa', 'awaiting_release', 'deploying',
    'resolved', 'blocked', 'cancelled'
  )),
  version INT NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY tickets_key_unique (`key`),
  UNIQUE KEY tickets_id_project_unique (id, project_id),
  KEY tickets_project_created_idx (project_id, created_at),
  CONSTRAINT tickets_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT tickets_creator_fk FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_comments (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  author_id CHAR(36) CHARACTER SET ascii NOT NULL,
  visibility VARCHAR(20) NOT NULL CHECK (visibility IN ('public', 'internal')),
  body TEXT NOT NULL CHECK (CHAR_LENGTH(body) BETWEEN 1 AND 20000),
  automated TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  version INT NOT NULL DEFAULT 0 CHECK (version >= 0),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  author_kind VARCHAR(20) NULL CHECK (author_kind IN ('agent', 'system')),
  KEY ticket_comments_ticket_created_idx (ticket_id, created_at),
  CONSTRAINT ticket_comments_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT ticket_comments_author_fk FOREIGN KEY (author_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_comment_revisions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  comment_id CHAR(36) CHARACTER SET ascii NOT NULL,
  version INT NOT NULL CHECK (version >= 0),
  editor_id CHAR(36) CHARACTER SET ascii NOT NULL,
  before_body TEXT NULL CHECK (before_body IS NULL OR CHAR_LENGTH(before_body) BETWEEN 1 AND 20000),
  after_body TEXT NOT NULL CHECK (CHAR_LENGTH(after_body) BETWEEN 1 AND 20000),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY ticket_comment_revisions_version (comment_id, version),
  CONSTRAINT ticket_comment_revisions_comment_fk FOREIGN KEY (comment_id) REFERENCES ticket_comments(id),
  CONSTRAINT ticket_comment_revisions_editor_fk FOREIGN KEY (editor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_events (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  from_status VARCHAR(30) NULL CHECK (from_status IN (
    'new', 'investigating', 'awaiting_information', 'awaiting_client', 'awaiting_confirmation',
    'awaiting_technical', 'implementing', 'awaiting_qa', 'awaiting_release', 'deploying',
    'resolved', 'blocked', 'cancelled'
  )),
  to_status VARCHAR(30) NOT NULL CHECK (to_status IN (
    'new', 'investigating', 'awaiting_information', 'awaiting_client', 'awaiting_confirmation',
    'awaiting_technical', 'implementing', 'awaiting_qa', 'awaiting_release', 'deploying',
    'resolved', 'blocked', 'cancelled'
  )),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  sequence BIGINT NOT NULL AUTO_INCREMENT,
  UNIQUE KEY ticket_events_sequence (sequence),
  KEY ticket_events_ticket_created_idx (ticket_id, created_at, sequence),
  CONSTRAINT ticket_events_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_revisions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  ticket_version INT NOT NULL CHECK (ticket_version >= 0),
  actor_id CHAR(36) CHARACTER SET ascii NOT NULL,
  before_data LONGTEXT NULL CHECK (before_data IS NULL OR (JSON_VALID(before_data) AND JSON_TYPE(before_data) = 'OBJECT')),
  after_data LONGTEXT NOT NULL CHECK (JSON_VALID(after_data) AND JSON_TYPE(after_data) = 'OBJECT'),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY ticket_revisions_version (ticket_id, ticket_version),
  CONSTRAINT ticket_revisions_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT ticket_revisions_actor_fk FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_assignments (
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  stage VARCHAR(20) NOT NULL CHECK (stage IN ('client', 'technical', 'qa', 'release')),
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  assigned_by CHAR(36) CHARACTER SET ascii NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (ticket_id, stage),
  UNIQUE KEY ticket_assignments_user (ticket_id, user_id),
  CONSTRAINT ticket_assignments_assigner_fk FOREIGN KEY (assigned_by) REFERENCES users(id),
  CONSTRAINT ticket_assignments_ticket_fk FOREIGN KEY (ticket_id, project_id) REFERENCES tickets(id, project_id),
  CONSTRAINT ticket_assignments_member_fk FOREIGN KEY (user_id, project_id)
    REFERENCES project_memberships(user_id, project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_participants (
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  changed_by CHAR(36) CHARACTER SET ascii NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (ticket_id, user_id),
  CONSTRAINT ticket_participants_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT ticket_participants_user_fk FOREIGN KEY (user_id) REFERENCES users(id),
  CONSTRAINT ticket_participants_changer_fk FOREIGN KEY (changed_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_resolutions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  ticket_version INT NOT NULL,
  body TEXT NOT NULL CHECK (CHAR_LENGTH(body) BETWEEN 10 AND 20000),
  hash CHAR(64) CHARACTER SET ascii NOT NULL CHECK (hash REGEXP '^[a-f0-9]{64}$'),
  created_by CHAR(36) CHARACTER SET ascii NOT NULL,
  client_id CHAR(36) CHARACTER SET ascii NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  invalidated_at DATETIME(3) NULL,
  decided_by CHAR(36) CHARACTER SET ascii NULL,
  decision_notes TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at DATETIME(3) NULL,
  UNIQUE KEY ticket_resolutions_version (ticket_id, ticket_version),
  CONSTRAINT ticket_resolutions_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT ticket_resolutions_creator_fk FOREIGN KEY (created_by) REFERENCES users(id),
  CONSTRAINT ticket_resolutions_client_fk FOREIGN KEY (client_id) REFERENCES users(id),
  CONSTRAINT ticket_resolutions_decider_fk FOREIGN KEY (decided_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_dependency_invalidations (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  ticket_version INT NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ticket_dependency_invalidations_ticket (ticket_id, ticket_version),
  CONSTRAINT ticket_dependency_invalidations_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT ticket_dependency_invalidations_actor_fk FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS proposals (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  version INT NOT NULL,
  hash CHAR(64) CHARACTER SET ascii NOT NULL CHECK (CHAR_LENGTH(hash) = 64),
  summary TEXT NOT NULL,
  steps LONGTEXT NOT NULL CHECK (JSON_VALID(steps)),
  acceptance_criteria LONGTEXT NOT NULL CHECK (JSON_VALID(acceptance_criteria)),
  risks LONGTEXT NOT NULL CHECK (JSON_VALID(risks)),
  created_by CHAR(36) CHARACTER SET ascii NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  invalidated_at DATETIME(3) NULL,
  UNIQUE KEY proposals_ticket_version (ticket_id, version),
  CONSTRAINT proposals_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT proposals_creator_fk FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approvals (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  ticket_version INT NOT NULL,
  stage VARCHAR(30) NOT NULL,
  artifact_hash VARCHAR(128) CHARACTER SET ascii NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii NOT NULL,
  decision VARCHAR(10) NOT NULL CHECK (decision IN ('approve', 'reject')),
  notes TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  invalidated_at DATETIME(3) NULL,
  UNIQUE KEY approvals_stage (ticket_id, ticket_version, stage),
  CONSTRAINT approvals_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id),
  CONSTRAINT approvals_actor_fk FOREIGN KEY (actor_id) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS execution_runs (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  ticket_version INT NOT NULL,
  proposal_hash VARCHAR(128) CHARACTER SET ascii NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'running', 'blocked', 'failed', 'completed')),
  error_code VARCHAR(100) NULL,
  candidate_hash VARCHAR(128) CHARACTER SET ascii NULL,
  manifest LONGTEXT NULL CHECK (manifest IS NULL OR JSON_VALID(manifest)),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  invalidated_at DATETIME(3) NULL,
  UNIQUE KEY execution_runs_version (ticket_id, ticket_version),
  KEY execution_runs_ticket (ticket_id, created_at),
  CONSTRAINT execution_runs_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS deployment_runs (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  ticket_version INT NOT NULL,
  candidate_hash VARCHAR(128) CHARACTER SET ascii NOT NULL,
  status VARCHAR(20) NOT NULL CHECK (status IN ('pending', 'running', 'blocked', 'failed', 'uncertain', 'completed')),
  verified_revision VARCHAR(100) NULL,
  error_code VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  invalidated_at DATETIME(3) NULL,
  UNIQUE KEY deployment_runs_version (ticket_id, ticket_version),
  CONSTRAINT deployment_runs_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notification_outbox (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  topic VARCHAR(100) NOT NULL,
  payload LONGTEXT NOT NULL CHECK (JSON_VALID(payload)),
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'blocked', 'failed')),
  error_code VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY notification_outbox_pending (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_events (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  actor_id CHAR(36) CHARACTER SET ascii NULL,
  ticket_id CHAR(36) CHARACTER SET ascii NULL,
  action VARCHAR(100) NOT NULL,
  details LONGTEXT NOT NULL DEFAULT '{}' CHECK (JSON_VALID(details)),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY audit_events_ticket (ticket_id, created_at),
  CONSTRAINT audit_events_actor_fk FOREIGN KEY (actor_id) REFERENCES users(id),
  CONSTRAINT audit_events_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS integration_settings (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NULL,
  environment VARCHAR(20) NOT NULL CHECK (environment IN ('quality', 'production')),
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('smtp', 'svn', 'documentation', 'telemetry', 'database', 'copilot', 'sandbox', 'deployment')),
  version INT NOT NULL CHECK (version > 0),
  state VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'verified', 'revoked')),
  values_ciphertext MEDIUMTEXT NULL,
  public_values LONGTEXT NOT NULL CHECK (JSON_VALID(public_values)),
  secret_configured TINYINT(1) NOT NULL DEFAULT 0,
  tested_at DATETIME(3) NULL,
  test_code VARCHAR(100) NULL,
  updated_by CHAR(36) CHARACTER SET ascii NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  scope_project CHAR(36) CHARACTER SET ascii AS (COALESCE(project_id, '00000000-0000-0000-0000-000000000000')) PERSISTENT,
  CONSTRAINT integration_settings_scope_check CHECK ((project_id IS NULL) = (kind = 'smtp')),
  CONSTRAINT integration_settings_secret_check CHECK (state = 'revoked' OR values_ciphertext IS NOT NULL),
  UNIQUE KEY integration_settings_scope (scope_project, environment, kind),
  CONSTRAINT integration_settings_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT integration_settings_updater_fk FOREIGN KEY (updated_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Chave legível ZO-n e guarda: tickets novos só para Qualidade ou Produção.
DROP TRIGGER IF EXISTS tickets_before_insert;
CREATE TRIGGER tickets_before_insert BEFORE INSERT ON tickets FOR EACH ROW
BEGIN
  IF NEW.environment = 'development' THEN
    SIGNAL SQLSTATE '23514' SET MESSAGE_TEXT = 'New tickets must target Quality or Production';
  END IF;
  IF NEW.`key` IS NULL OR NEW.`key` = '' THEN
    UPDATE ticket_key_counter SET value = LAST_INSERT_ID(value + 1) WHERE id = 1;
    SET NEW.`key` = CONCAT('ZO-', LAST_INSERT_ID());
  END IF;
END;

DROP TRIGGER IF EXISTS tickets_before_update;
CREATE TRIGGER tickets_before_update BEFORE UPDATE ON tickets FOR EACH ROW
BEGIN
  IF NEW.environment = 'development' AND NOT (OLD.environment <=> NEW.environment) THEN
    SIGNAL SQLSTATE '23514' SET MESSAGE_TEXT = 'New tickets must target Quality or Production';
  END IF;
END;

-- Preserva inserções legadas em users; as pertenças são a fonte de autorização.
DROP TRIGGER IF EXISTS users_legacy_membership_insert;
CREATE TRIGGER users_legacy_membership_insert AFTER INSERT ON users FOR EACH ROW
BEGIN
  INSERT IGNORE INTO project_memberships (user_id, project_id, role, organization)
  VALUES (NEW.id, NEW.project_id, NEW.role, NEW.organization);
END;

DROP TRIGGER IF EXISTS users_legacy_membership_update;
CREATE TRIGGER users_legacy_membership_update AFTER UPDATE ON users FOR EACH ROW
BEGIN
  IF NOT (NEW.project_id <=> OLD.project_id) OR NOT (NEW.role <=> OLD.role)
     OR NOT (NEW.organization <=> OLD.organization) THEN
    INSERT INTO project_memberships (user_id, project_id, role, organization)
    VALUES (NEW.id, NEW.project_id, NEW.role, NEW.organization)
    ON DUPLICATE KEY UPDATE role = VALUES(role), organization = VALUES(organization),
      updated_at = CURRENT_TIMESTAMP(3);
  END IF;
END;

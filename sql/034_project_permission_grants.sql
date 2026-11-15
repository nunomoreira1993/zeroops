-- P01: grants explicitos, limitados a uma pertença existente.
-- A administracao mantém os poderes atuais; nao são criados grants nem papeis por omissao.
-- Idempotente e aditiva. Revogacoes individuais são auditadas pela aplicação, sem cascata.
CREATE TABLE IF NOT EXISTS project_permission_grants (
  user_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  permission VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  granted_by CHAR(36) CHARACTER SET ascii NOT NULL,
  granted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, project_id, permission),
  KEY project_permission_grants_project (project_id, user_id),
  CONSTRAINT project_permission_grants_membership_fk FOREIGN KEY (user_id, project_id)
    REFERENCES project_memberships(user_id, project_id),
  CONSTRAINT project_permission_grants_actor_fk FOREIGN KEY (granted_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

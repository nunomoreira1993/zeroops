-- Perfis reutilizaveis de agentes ZeroOps. As versoes sao imutaveis; fluxos publicados guardam
-- o identificador e a versao escolhidos. Recursos tecnicos continuam no repositorio do projeto.
CREATE TABLE IF NOT EXISTS zeroops_agent_profiles (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  name VARCHAR(80) NOT NULL,
  current_version INT UNSIGNED NOT NULL DEFAULT 1,
  archived_at DATETIME(3) NULL,
  created_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY zeroops_agent_profiles_name (project_id, name),
  UNIQUE KEY zeroops_agent_profiles_scope (id, project_id),
  CONSTRAINT zeroops_agent_profiles_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT zeroops_agent_profiles_author_fk
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS zeroops_agent_profile_versions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  profile_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  version INT UNSIGNED NOT NULL,
  definition LONGTEXT NOT NULL CHECK (JSON_VALID(definition)),
  created_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY zeroops_agent_profile_versions_number (profile_id, version),
  UNIQUE KEY zeroops_agent_profile_versions_scope (profile_id, project_id, version),
  CONSTRAINT zeroops_agent_profile_versions_profile_fk
    FOREIGN KEY (profile_id, project_id)
    REFERENCES zeroops_agent_profiles(id, project_id) ON DELETE CASCADE,
  CONSTRAINT zeroops_agent_profile_versions_author_fk
    FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Auditoria do contexto efetivo no proprio run (ticket-owned, removido com o respetivo ticket).
-- O texto completo dos recursos carregados e guardado para preservar a origem do contexto.
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS agent_profile_id CHAR(36) CHARACTER SET ascii NULL,
  ADD COLUMN IF NOT EXISTS agent_profile_version INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS agent_profile_snapshot LONGTEXT NULL
    CHECK (agent_profile_snapshot IS NULL OR JSON_VALID(agent_profile_snapshot)),
  ADD COLUMN IF NOT EXISTS repository_snapshot_hash CHAR(64) CHARACTER SET ascii NULL,
  ADD COLUMN IF NOT EXISTS repository_resources LONGTEXT NULL
    CHECK (repository_resources IS NULL OR JSON_VALID(repository_resources)),
  ADD COLUMN IF NOT EXISTS allowed_tools LONGTEXT NULL
    CHECK (allowed_tools IS NULL OR JSON_VALID(allowed_tools)),
  ADD COLUMN IF NOT EXISTS effective_tools LONGTEXT NULL
    CHECK (effective_tools IS NULL OR JSON_VALID(effective_tools)),
  ADD COLUMN IF NOT EXISTS effective_model VARCHAR(100) NULL;

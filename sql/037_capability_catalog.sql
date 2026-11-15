-- P04: catalogo de skills versionadas (bundles imutaveis com hash), proveniencia das importacoes,
-- partilha explicita entre projetos e bindings locais (ferramentas autorizadas por projeto).
-- Evolui o catalogo de perfis existente (030) em vez de criar outro: os agentes continuam em
-- zeroops_agent_profiles; ganham apenas a proveniencia da versao importada.
-- Aditiva e idempotente. Partilhar nunca copia bindings, credenciais nem conversas.

CREATE TABLE IF NOT EXISTS zeroops_skills (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  current_version INT UNSIGNED NOT NULL DEFAULT 1,
  archived_at DATETIME(3) NULL,
  created_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY zeroops_skills_name (project_id, name),
  UNIQUE KEY zeroops_skills_scope (id, project_id),
  CONSTRAINT zeroops_skills_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT zeroops_skills_author_fk FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Versao imutavel: so INSERT. `bundle_hash` = sha256 canonico de metadados + (path, sha256).
CREATE TABLE IF NOT EXISTS zeroops_skill_versions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  skill_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  version INT UNSIGNED NOT NULL,
  description VARCHAR(1024) NOT NULL,
  bundle_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  manifest LONGTEXT NOT NULL CHECK (JSON_VALID(manifest)),
  provenance LONGTEXT NOT NULL CHECK (JSON_VALID(provenance)),
  created_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY zeroops_skill_versions_number (skill_id, version),
  KEY zeroops_skill_versions_project (project_id),
  CONSTRAINT zeroops_skill_versions_skill_fk
    FOREIGN KEY (skill_id, project_id) REFERENCES zeroops_skills(id, project_id) ON DELETE CASCADE,
  CONSTRAINT zeroops_skill_versions_author_fk FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ficheiros de cada versao (SKILL.md, scripts, referencias, exemplos), so texto e com hash.
CREATE TABLE IF NOT EXISTS zeroops_skill_version_files (
  version_id CHAR(36) CHARACTER SET ascii NOT NULL,
  path VARCHAR(240) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sha256 CHAR(64) CHARACTER SET ascii NOT NULL,
  size INT UNSIGNED NOT NULL,
  content LONGTEXT NOT NULL,
  PRIMARY KEY (version_id, path),
  CONSTRAINT zeroops_skill_version_files_version_fk
    FOREIGN KEY (version_id) REFERENCES zeroops_skill_versions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Binding local: ferramenta do projeto que a skill pode usar. Revogar remove a linha (auditado).
CREATE TABLE IF NOT EXISTS zeroops_skill_bindings (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  skill_id CHAR(36) CHARACTER SET ascii NOT NULL,
  tool_key VARCHAR(32) CHARACTER SET ascii NOT NULL,
  created_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (project_id, skill_id, tool_key),
  CONSTRAINT zeroops_skill_bindings_skill_fk
    FOREIGN KEY (skill_id, project_id) REFERENCES zeroops_skills(id, project_id) ON DELETE CASCADE,
  CONSTRAINT zeroops_skill_bindings_author_fk FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Partilha explicita de uma versao com outro projeto; a adocao cria uma copia local com
-- proveniencia (sem bindings, credenciais nem conversas). Revogar impede novas adocoes.
CREATE TABLE IF NOT EXISTS zeroops_capability_shares (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  kind VARCHAR(10) CHARACTER SET ascii NOT NULL CHECK (kind IN ('skill', 'agent')),
  capability_id CHAR(36) CHARACTER SET ascii NOT NULL,
  version INT UNSIGNED NOT NULL,
  source_project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  target_project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  shared_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL,
  revoked_by CHAR(36) CHARACTER SET ascii NULL,
  adopted_capability_id CHAR(36) CHARACTER SET ascii NULL,
  KEY zeroops_capability_shares_target (target_project_id, revoked_at),
  KEY zeroops_capability_shares_source (source_project_id, kind, capability_id),
  CONSTRAINT zeroops_capability_shares_source_fk
    FOREIGN KEY (source_project_id) REFERENCES projects(id) ON DELETE CASCADE,
  CONSTRAINT zeroops_capability_shares_target_fk
    FOREIGN KEY (target_project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Proveniencia de versoes de perfis importadas de `.agent.md` ou adotadas de outro projeto.
ALTER TABLE zeroops_agent_profile_versions
  ADD COLUMN IF NOT EXISTS provenance LONGTEXT NULL CHECK (provenance IS NULL OR JSON_VALID(provenance));

-- Capacidades fixadas no run (agente principal, especialistas, skills e limites de delegacao).
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS capability_manifest LONGTEXT NULL
    CHECK (capability_manifest IS NULL OR JSON_VALID(capability_manifest)),
  ADD COLUMN IF NOT EXISTS capability_manifest_hash CHAR(64) CHARACTER SET ascii NULL;

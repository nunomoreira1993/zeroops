-- P02: rascunho separado da configuracao ativa, versoes com manifesto e ativacao explicita.
-- `flows.priority/is_default/flow_match` passam a ser o encaminhamento do RASCUNHO; o que esta
-- em servico fica em `flows.active_*` (copiado aqui do estado atual, sem mudar comportamento).
-- `published_version_id` continua a apontar para a versao ativa para novos tickets.
-- Aditiva e idempotente: nao remove nem reescreve dados; as execucoes continuam presas a versao.

ALTER TABLE flow_versions
  ADD COLUMN IF NOT EXISTS schema_version TINYINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS runtime_contract_version SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS routing LONGTEXT NULL CHECK (routing IS NULL OR JSON_VALID(routing)),
  ADD COLUMN IF NOT EXISTS manifest LONGTEXT NULL CHECK (manifest IS NULL OR JSON_VALID(manifest)),
  ADD COLUMN IF NOT EXISTS manifest_hash CHAR(64) CHARACTER SET ascii NULL;

ALTER TABLE flows
  ADD COLUMN IF NOT EXISTS active_priority INT NULL,
  ADD COLUMN IF NOT EXISTS active_is_default TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS active_flow_match LONGTEXT NULL
    CHECK (active_flow_match IS NULL OR JSON_VALID(active_flow_match)),
  -- Alertas da Saude que o rascunho reclama quando for ativado (lista JSON de chaves).
  ADD COLUMN IF NOT EXISTS pending_alert_keys LONGTEXT NULL
    CHECK (pending_alert_keys IS NULL OR JSON_VALID(pending_alert_keys)),
  ADD COLUMN IF NOT EXISTS active_default_project CHAR(36) CHARACTER SET ascii
    AS (IF(active_is_default = 1, project_id, NULL)) PERSISTENT;

CREATE UNIQUE INDEX IF NOT EXISTS flows_one_active_default ON flows (active_default_project);

-- Preserva o encaminhamento em servico dos fluxos ja publicados (so na primeira execucao).
UPDATE flows
   SET active_priority = priority,
       active_is_default = is_default,
       active_flow_match = flow_match
 WHERE published_version_id IS NOT NULL AND active_priority IS NULL;

CREATE TABLE IF NOT EXISTS flow_activations (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  version_id CHAR(36) CHARACTER SET ascii NULL,
  kind VARCHAR(24) CHARACTER SET ascii NOT NULL
    CHECK (kind IN ('activation', 'migration', 'alert_link', 'default_transfer')),
  actor_id CHAR(36) CHARACTER SET ascii NULL,
  base_draft_version INT NULL,
  previous_version_id CHAR(36) CHARACTER SET ascii NULL,
  manifest_hash CHAR(64) CHARACTER SET ascii NULL,
  activation_details LONGTEXT NULL
    CHECK (activation_details IS NULL OR JSON_VALID(activation_details)),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Uma revisao do rascunho so pode ser ativada uma vez (repeticoes/concorrencia).
  UNIQUE KEY flow_activations_once (flow_id, kind, base_draft_version),
  KEY flow_activations_history (flow_id, created_at),
  KEY flow_activations_project (project_id, created_at),
  CONSTRAINT flow_activations_flow_fk FOREIGN KEY (flow_id, project_id)
    REFERENCES flows(id, project_id) ON DELETE CASCADE,
  CONSTRAINT flow_activations_version_fk FOREIGN KEY (version_id) REFERENCES flow_versions(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ponto de partida do historico: a versao em servico antes do P02.
INSERT IGNORE INTO flow_activations (id, project_id, flow_id, version_id, kind, base_draft_version, created_at)
SELECT UUID(), f.project_id, f.id, f.published_version_id, 'migration', NULL, v.published_at
  FROM flows f
  JOIN flow_versions v ON v.id = f.published_version_id
 WHERE NOT EXISTS (
   SELECT 1 FROM flow_activations a WHERE a.flow_id = f.id AND a.kind = 'migration'
 );

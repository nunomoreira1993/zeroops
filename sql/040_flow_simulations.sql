-- P07: simulador partilhado com o runtime.
-- `flow_simulation_scenarios`: biblioteca de cenarios por fluxo (factos do pedido, resultados de
-- ferramentas/agentes, respostas, decisoes, tempo e expectativas). Versao para controlo otimista.
-- `flow_simulation_runs`: cada execucao de teste fica ligada aos hashes exatos da definicao, do
-- encaminhamento, do manifesto de dependencias e do cenario. A avaliacao com Copilot real corre
-- como job (leases do P03); os restantes niveis terminam no pedido.
-- `flow_trial_targets`/`flow_trial_deliveries`: destinos de ensaio isolado (outbox) por projeto;
-- o ensaio entrega aqui mensagens e operacoes, nunca no ticket ou nos recursos reais.
-- Aditiva e idempotente.

CREATE TABLE IF NOT EXISTS flow_simulation_scenarios (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  name VARCHAR(120) NOT NULL,
  description VARCHAR(1000) NOT NULL DEFAULT '',
  spec LONGTEXT NOT NULL CHECK (JSON_VALID(spec)),
  spec_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  archived TINYINT(1) NOT NULL DEFAULT 0,
  created_by CHAR(36) CHARACTER SET ascii NULL,
  updated_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY flow_simulation_scenarios_flow (flow_id, archived, name),
  CONSTRAINT flow_simulation_scenarios_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT flow_simulation_scenarios_flow_fk FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_trial_targets (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  name VARCHAR(120) NOT NULL,
  kind VARCHAR(20) CHARACTER SET ascii NOT NULL DEFAULT 'outbox',
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT flow_trial_targets_kind_check CHECK (kind IN ('outbox')),
  KEY flow_trial_targets_project (project_id, active),
  CONSTRAINT flow_trial_targets_project_fk FOREIGN KEY (project_id) REFERENCES projects(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_simulation_runs (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  flow_id CHAR(36) CHARACTER SET ascii NOT NULL,
  scenario_id CHAR(36) CHARACTER SET ascii NULL,
  scenario_version INT UNSIGNED NULL,
  scenario_name VARCHAR(120) NOT NULL,
  scenario_spec LONGTEXT NOT NULL CHECK (JSON_VALID(scenario_spec)),
  level VARCHAR(20) CHARACTER SET ascii NOT NULL,
  status VARCHAR(20) CHARACTER SET ascii NOT NULL,
  definition_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  routing_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  manifest_hash CHAR(64) CHARACTER SET ascii NULL,
  scenario_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  -- Definicao e candidatos fixados no pedido (o job usa sempre este conjunto).
  run_input LONGTEXT NOT NULL CHECK (JSON_VALID(run_input)),
  result LONGTEXT NULL CHECK (result IS NULL OR JSON_VALID(result)),
  comparison LONGTEXT NULL CHECK (comparison IS NULL OR JSON_VALID(comparison)),
  verdict VARCHAR(20) CHARACTER SET ascii NULL,
  trial_target_id CHAR(36) CHARACTER SET ascii NULL,
  idempotency_key VARCHAR(80) NOT NULL,
  requested_by CHAR(36) CHARACTER SET ascii NULL,
  available_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  attempt INT UNSIGNED NOT NULL DEFAULT 0,
  worker_id VARCHAR(120) NULL,
  lease_epoch INT UNSIGNED NOT NULL DEFAULT 0,
  lease_until DATETIME(3) NULL,
  heartbeat_at DATETIME(3) NULL,
  cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
  error_code VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  CONSTRAINT flow_simulation_runs_level_check
    CHECK (level IN ('structural', 'behavior', 'routing_copilot', 'isolated_trial')),
  CONSTRAINT flow_simulation_runs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  UNIQUE KEY flow_simulation_runs_idempotency (flow_id, idempotency_key),
  KEY flow_simulation_runs_flow (flow_id, created_at),
  KEY flow_simulation_runs_manifest (flow_id, manifest_hash, status),
  KEY flow_simulation_runs_queue (status, available_at),
  KEY flow_simulation_runs_lease (status, lease_until),
  CONSTRAINT flow_simulation_runs_project_fk FOREIGN KEY (project_id) REFERENCES projects(id),
  CONSTRAINT flow_simulation_runs_flow_fk FOREIGN KEY (flow_id) REFERENCES flows(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS flow_trial_deliveries (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  target_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  -- Nome distinto de `run_id` (que o purge de tickets reserva para dependencias de tickets).
  simulation_run_id CHAR(36) CHARACTER SET ascii NOT NULL,
  node_id VARCHAR(64) NOT NULL,
  attempt INT UNSIGNED NOT NULL,
  kind VARCHAR(30) CHARACTER SET ascii NOT NULL,
  payload LONGTEXT NOT NULL CHECK (JSON_VALID(payload)),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY flow_trial_deliveries_target (target_id, id),
  KEY flow_trial_deliveries_run (simulation_run_id),
  CONSTRAINT flow_trial_deliveries_target_fk FOREIGN KEY (target_id) REFERENCES flow_trial_targets(id),
  CONSTRAINT flow_trial_deliveries_run_fk FOREIGN KEY (simulation_run_id) REFERENCES flow_simulation_runs(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Eventos de leases tambem para as avaliacoes Copilot do simulador.
ALTER TABLE agent_job_events MODIFY job_kind VARCHAR(20) CHARACTER SET ascii NOT NULL;
ALTER TABLE agent_job_events DROP CONSTRAINT IF EXISTS agent_job_events_kind_check;
ALTER TABLE agent_job_events ADD CONSTRAINT agent_job_events_kind_check
  CHECK (job_kind IN ('agent_run', 'flow_assistant', 'ticket_routing', 'flow_simulation'));

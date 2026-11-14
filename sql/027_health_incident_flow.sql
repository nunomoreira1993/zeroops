-- Fluxo «Incidente (Health)»: recurso afetado, componentes do alerta e da causa, politica de
-- intervencao por projeto, registo de intervencoes (com valor anterior e forma de repor) e
-- suspensao da Saude por projeto e ambiente. Idempotente; nao apaga dados.

-- Recurso e componentes do incidente (a causa e preenchida pela investigacao).
ALTER TABLE health_incidents
  ADD COLUMN IF NOT EXISTS resource_kind VARCHAR(32) CHARACTER SET ascii NULL,
  ADD COLUMN IF NOT EXISTS resource_engine VARCHAR(32) CHARACTER SET ascii NULL,
  ADD COLUMN IF NOT EXISTS resource_host VARCHAR(160) NULL,
  ADD COLUMN IF NOT EXISTS resource_unit VARCHAR(120) NULL,
  ADD COLUMN IF NOT EXISTS resource_managed TINYINT(1) NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS alert_component VARCHAR(160) NULL,
  ADD COLUMN IF NOT EXISTS cause_component VARCHAR(160) NULL,
  ADD COLUMN IF NOT EXISTS cause_confirmed TINYINT(1) NOT NULL DEFAULT 0,
  -- Cenario de demonstracao (alertas sinteticos): intervencoes e validacoes simuladas.
  ADD COLUMN IF NOT EXISTS demo_scenario VARCHAR(32) CHARACTER SET ascii NULL;

-- Execucoes de fluxo paradas pela suspensao da Saude (retoma manual no ticket).
ALTER TABLE flow_executions
  ADD COLUMN IF NOT EXISTS suspended_at DATETIME(3) NULL;

-- Politica de intervencao por projeto (regras, servicos e parametros permitidos, validacao).
CREATE TABLE IF NOT EXISTS incident_policies (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  policy LONGTEXT NOT NULL CHECK (JSON_VALID(policy)),
  version INT NOT NULL DEFAULT 1,
  updated_by CHAR(36) CHARACTER SET ascii NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT incident_policies_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Registo de cada intervencao: decisao, comando tipado, antes/depois, resultado e reposicao.
CREATE TABLE IF NOT EXISTS incident_interventions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  environment VARCHAR(20) NOT NULL CHECK (environment IN ('quality', 'production')),
  step_id CHAR(36) CHARACTER SET ascii NULL,
  action VARCHAR(32) CHARACTER SET ascii NOT NULL,
  target VARCHAR(160) NOT NULL,
  parameter VARCHAR(40) NULL,
  previous_value VARCHAR(120) NULL,
  new_value VARCHAR(120) NULL,
  rollback_hint VARCHAR(500) NULL,
  decision VARCHAR(16) CHARACTER SET ascii NOT NULL CHECK (decision IN ('auto', 'approval', 'forbidden')),
  decision_reason VARCHAR(500) NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'refused', 'cancelled', 'simulated')),
  relay_request_id CHAR(36) CHARACTER SET ascii NULL,
  result_text VARCHAR(2000) NULL,
  actor_kind VARCHAR(8) CHARACTER SET ascii NOT NULL DEFAULT 'agent' CHECK (actor_kind IN ('agent', 'human')),
  actor_id CHAR(36) CHARACTER SET ascii NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  KEY incident_interventions_ticket (ticket_id, created_at),
  KEY incident_interventions_active (project_id, environment, status),
  CONSTRAINT incident_interventions_ticket_fk FOREIGN KEY (ticket_id) REFERENCES tickets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Suspensao manual da Saude (tudo menos o registo dos alertas), com historico.
CREATE TABLE IF NOT EXISTS health_suspensions (
  id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  environment VARCHAR(20) NOT NULL CHECK (environment IN ('quality', 'production')),
  reason VARCHAR(500) NOT NULL,
  suspended_by CHAR(36) CHARACTER SET ascii NOT NULL,
  suspended_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resumed_by CHAR(36) CHARACTER SET ascii NULL,
  resumed_at DATETIME(3) NULL,
  cancelled_runs INT NOT NULL DEFAULT 0,
  KEY health_suspensions_active (project_id, environment, resumed_at),
  CONSTRAINT health_suspensions_project_fk FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Alertas recebidos durante a suspensao ficam so registados e marcados.
ALTER TABLE health_external_alerts
  ADD COLUMN IF NOT EXISTS suspended TINYINT(1) NOT NULL DEFAULT 0;

-- Ferramentas anunciadas pelo relay de Producao (ex.: db2 so quando o servidor tem ODBC configurado).
ALTER TABLE connector_relays
  ADD COLUMN IF NOT EXISTS tools VARCHAR(200) CHARACTER SET ascii NULL;

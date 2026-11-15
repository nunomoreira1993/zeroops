-- P11: migracao explicita e auditada dos tickets antigos sem execucao de fluxo.
-- O worker deixou de colocar automaticamente estes tickets no fluxo por omissao (backfill no
-- arranque). Cada ticket recebe uma disposicao explicita, registada uma unica vez por um operador:
--   `start`   - entra no fluxo ativo do projeto na decisao da equipa (sem repetir trabalho feito);
--   `exclude` - fica fora dos fluxos; a equipa continua a trata-lo pelas rotas legadas.
-- A chave primaria por ticket impede adocoes repetidas; a execucao criada (se houver) fica
-- referenciada para auditoria. Nao altera dados existentes. Aditiva e idempotente.

CREATE TABLE IF NOT EXISTS ticket_flow_adoptions (
  ticket_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  project_id CHAR(36) CHARACTER SET ascii NOT NULL,
  disposition VARCHAR(10) CHARACTER SET ascii NOT NULL,
  flow_id CHAR(36) CHARACTER SET ascii NULL,
  version_id CHAR(36) CHARACTER SET ascii NULL,
  execution_id CHAR(36) CHARACTER SET ascii NULL,
  selection_digest CHAR(64) CHARACTER SET ascii NOT NULL,
  actor_id CHAR(36) CHARACTER SET ascii NOT NULL,
  reason VARCHAR(500) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT ticket_flow_adoptions_disposition_check CHECK (disposition IN ('start', 'exclude')),
  KEY ticket_flow_adoptions_project (project_id, created_at),
  CONSTRAINT ticket_flow_adoptions_ticket_fk FOREIGN KEY (ticket_id, project_id) REFERENCES tickets(id, project_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

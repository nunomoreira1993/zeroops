-- Chat Equipa · Copilot: modelo e esforco escolhidos em cada investigacao, catalogo de modelos da
-- conta Copilot de cada projeto (cache atualizada pelo executor) e fotografia de perfil.
-- Idempotente; runs existentes ficam com modelo/esforco NULL (= modelo da integracao).

ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS model VARCHAR(100) NULL,
  ADD COLUMN IF NOT EXISTS reasoning_effort VARCHAR(20) CHARACTER SET ascii NULL;

-- Nota final de cada investigacao ligada ao run, para o chat mostrar a conclusao e as interacoes
-- na mesma resposta. Notas antigas: liga pela proximidade ao fim do run no mesmo ticket.
ALTER TABLE ticket_comments
  ADD COLUMN IF NOT EXISTS agent_run_id CHAR(36) CHARACTER SET ascii NULL;

UPDATE ticket_comments c
  JOIN agent_runs r ON r.ticket_id = c.ticket_id AND r.status = 'succeeded'
    AND r.finished_at IS NOT NULL
    AND ABS(TIMESTAMPDIFF(SECOND, r.finished_at, c.created_at)) <= 5
  SET c.agent_run_id = r.id
  WHERE c.author_kind = 'agent' AND c.agent_run_id IS NULL;

-- Uma linha por projeto. refresh_requested_at > refreshed_at (ou refreshed_at NULL) = o executor
-- deve voltar a ler a lista de modelos do SDK.
CREATE TABLE IF NOT EXISTS agent_model_catalogs (
  project_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  models JSON NULL,
  default_model VARCHAR(100) NULL,
  refreshed_at DATETIME(3) NULL,
  refresh_requested_at DATETIME(3) NULL,
  error_code VARCHAR(60) CHARACTER SET ascii NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Fotografia de perfil (PNG, JPEG ou WebP ate 512 KB) numa tabela propria para nao pesar nas
-- consultas a users; avatar_version muda a cada alteracao para invalidar a cache do browser.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_version INT NULL;

CREATE TABLE IF NOT EXISTS user_avatars (
  user_id CHAR(36) CHARACTER SET ascii NOT NULL PRIMARY KEY,
  mime VARCHAR(40) CHARACTER SET ascii NOT NULL,
  data MEDIUMBLOB NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  CONSTRAINT fk_user_avatars_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

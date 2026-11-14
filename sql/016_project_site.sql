-- Site (plataforma) ligado a cada projeto: define o codigo-fonte do agente, as instrucoes por
-- omissao e a instancia do relay de Producao. Idempotente.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS site_key VARCHAR(40) CHARACTER SET ascii NULL
    CHECK (site_key IS NULL OR site_key IN ('pizzahut', 'pizzamovil'));

-- O projeto inicial e o da Pizza Hut.
UPDATE projects SET site_key = 'pizzahut'
WHERE id = '00000000-0000-4000-8000-000000000001' AND site_key IS NULL;

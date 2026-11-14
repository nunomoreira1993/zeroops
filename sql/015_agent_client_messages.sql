-- Canal do cliente separado do trabalho do agente. Idempotente.
-- client_questions: perguntas que o agente dirigiu ao cliente (lista JSON).
-- run_trigger: origem do run (manual = pedido pela equipa; client_reply = resposta do cliente).
-- client_message_id: mensagem publica criada automaticamente com as perguntas.
ALTER TABLE agent_runs
  ADD COLUMN IF NOT EXISTS client_questions LONGTEXT NULL CHECK (client_questions IS NULL OR JSON_VALID(client_questions)),
  ADD COLUMN IF NOT EXISTS run_trigger VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (run_trigger IN ('manual', 'client_reply')),
  ADD COLUMN IF NOT EXISTS client_message_id CHAR(36) CHARACTER SET ascii NULL;

-- Envio automatico das perguntas do agente ao cliente (ligado por omissao). Desligado, as
-- perguntas ficam so na nota interna para a equipa as rever.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS agent_auto_client_questions TINYINT(1) NOT NULL DEFAULT 1;

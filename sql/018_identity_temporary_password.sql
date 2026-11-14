-- Convites com palavra-passe temporaria: o convite guarda o hash da palavra-passe enviada por
-- email e a conta criada no primeiro login fica obrigada a definir uma nova palavra-passe.
-- Convites antigos (sem hash) continuam a funcionar pela ligacao de ativacao. Idempotente.
ALTER TABLE identity_invites ADD COLUMN IF NOT EXISTS temp_password_hash VARCHAR(255) NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_change_required TINYINT(1) NOT NULL DEFAULT 0;
